// App.tsx
//
// Consolidated app file — combines everything built so far:
//   - Mesh tab:     offline Bluetooth group chat (via expo-bitchat)
//   - Location tab: geohash-based public channels over Nostr relays
//   - Peers tab:    encrypted 1:1 messages with nearby mesh peers
//
// This MUST be the project's root App.tsx — the very first import
// below has to run before anything else touches crypto.

import 'react-native-get-random-values';

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  PermissionsAndroid,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BitchatAPI, { BitchatMessage } from 'expo-bitchat';
import {
  generateSecretKey,
  finalizeEvent,
  verifyEvent,
  type Event,
  type EventTemplate,
} from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

/* =========================================================================
   GEOHASH UTILITY
   Standard geohash encoding (Niemeyer's algorithm). Precision tiers match
   bitchat's own #location channels screen: block/neighborhood/city/
   province/region, each backed by a coarser geohash prefix.
   ========================================================================= */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(latitude: number, longitude: number, precision = 9): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let geohash = '';
  let bit = 0;
  let ch = 0;
  let evenBit = true;

  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (longitude >= mid) {
        ch |= 1 << (4 - bit);
        lonMin = mid;
      } else {
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) {
        ch |= 1 << (4 - bit);
        latMin = mid;
      } else {
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (bit < 4) {
      bit++;
    } else {
      geohash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return geohash;
}

const GEOHASH_TIERS = [
  { name: 'block', precision: 7, approxRadiusKm: 0.2 },
  { name: 'neighborhood', precision: 6, approxRadiusKm: 1.2 },
  { name: 'city', precision: 5, approxRadiusKm: 4.9 },
  { name: 'province', precision: 4, approxRadiusKm: 39.1 },
  { name: 'region', precision: 2, approxRadiusKm: 1250 },
] as const;

type LocationTier = {
  name: string;
  precision: number;
  approxRadiusKm: number;
  geohash: string;
};

function getLocationTiers(latitude: number, longitude: number): LocationTier[] {
  const full = encodeGeohash(latitude, longitude, 7);
  return GEOHASH_TIERS.map((tier) => ({
    ...tier,
    geohash: full.slice(0, tier.precision),
  }));
}

/* =========================================================================
   NOSTR GEOHASH CLIENT
   Publishes/subscribes to ephemeral kind-20000 events tagged with #g,
   matching bitchat's own geohash channel convention. Runs over plain
   WebSocket relays — no native module needed for this part.
   ========================================================================= */

const GEOHASH_MESSAGE_KIND = 20000;
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];

// Bitchat derives a fresh, unlinkable Nostr identity per geohash so a
// user's activity in one location can't be tied to another. This is a
// simpler version: generate a random keypair the first time the user
// joins a geohash, then persist it locally so the pseudonym stays
// stable within that channel afterward.
async function getOrCreateGeohashKey(geohash: string): Promise<Uint8Array> {
  const storageKey = `nostr_geohash_key_${geohash}`;
  const stored = await AsyncStorage.getItem(storageKey);
  if (stored) {
    const bytes = stored.match(/.{1,2}/g)!.map((b) => parseInt(b, 16));
    return new Uint8Array(bytes);
  }
  const secretKey = generateSecretKey();
  const hex = Array.from(secretKey)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await AsyncStorage.setItem(storageKey, hex);
  return secretKey;
}

async function publishGeohashMessage(
  geohash: string,
  content: string,
  relayUrls: string[] = DEFAULT_RELAYS
): Promise<Event> {
  const secretKey = await getOrCreateGeohashKey(geohash);
  const template: EventTemplate = {
    kind: GEOHASH_MESSAGE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['g', geohash]],
    content,
  };
  const event = finalizeEvent(template, secretKey);

  await Promise.all(
    relayUrls.map(async (url) => {
      try {
        const relay = await Relay.connect(url);
        await relay.publish(event);
        relay.close();
      } catch (err) {
        console.warn(`Failed to publish to ${url}`, err);
      }
    })
  );

  return event;
}

function subscribeToGeohash(
  geohash: string,
  onMessage: (event: Event) => void,
  relayUrls: string[] = DEFAULT_RELAYS
): () => void {
  const closers: (() => void)[] = [];
  let cancelled = false;

  relayUrls.forEach(async (url) => {
    try {
      const relay = await Relay.connect(url);
      if (cancelled) {
        relay.close();
        return;
      }
      const sub = relay.subscribe(
        [
          {
            kinds: [GEOHASH_MESSAGE_KIND],
            '#g': [geohash],
            since: Math.floor(Date.now() / 1000) - 3600,
          },
        ],
        {
          onevent(event: Event) {
            if (verifyEvent(event)) {
              onMessage(event);
            }
          },
        }
      );
      closers.push(() => sub.close());
      closers.push(() => relay.close());
    } catch (err) {
      console.warn(`Failed to subscribe on ${url}`, err);
    }
  });

  return () => {
    cancelled = true;
    closers.forEach((close) => close());
  };
}

/* =========================================================================
   BLUETOOTH PERMISSIONS
   Android's BLE permission model changed at API 31 (Android 12). This
   app's floor is Android 10 (API 29), so both models have to be
   handled:
     - API 29-30 (Android 10-11): BLE scanning requires the
       ACCESS_FINE_LOCATION runtime permission. BLUETOOTH and
       BLUETOOTH_ADMIN are install-time "normal" permissions on these
       versions, so no runtime request is needed for those two.
     - API 31+ (Android 12+): BLUETOOTH_SCAN, BLUETOOTH_CONNECT, and
       BLUETOOTH_ADVERTISE became their own runtime permissions;
       location is no longer required for scanning specifically, but
       this app still asks for it separately for the Location tab.
   iOS needs no equivalent JS call — its prompts are driven by the
   NSBluetooth*UsageDescription strings in Info.plist.
   ========================================================================= */

async function ensureBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const apiLevel = Platform.Version as number;

  if (apiLevel >= 31) {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    ]);
    return Object.values(granted).every(
      (result) => result === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  // API 29-30 (Android 10-11)
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

/* =========================================================================
   MESH TAB — offline Bluetooth group chat
   ========================================================================= */

const MESH_CHANNEL = '#test';

function MeshChatScreen() {
  const [nickname] = useState(`user${Math.floor(Math.random() * 1000)}`);
  const [started, setStarted] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [messages, setMessages] = useState<BitchatMessage[]>([]);
  const [input, setInput] = useState('');
  const [peerCount, setPeerCount] = useState(0);

  useEffect(() => {
    let messageSub: { remove: () => void } | undefined;
    let peerConnectedSub: { remove: () => void } | undefined;
    let peerDisconnectedSub: { remove: () => void } | undefined;

    const start = async () => {
      const permitted = await ensureBluetoothPermissions();
      if (!permitted) {
        setPermissionDenied(true);
        return;
      }

      await BitchatAPI.startServices(nickname);
      setStarted(true);

      messageSub = BitchatAPI.addMessageListener((message: BitchatMessage) => {
        setMessages((prev) => [...prev, message]);
      });

      const refreshPeerCount = async () => {
        const peers = await BitchatAPI.getConnectedPeers();
        setPeerCount(Object.keys(peers).length);
      };

      peerConnectedSub = BitchatAPI.addPeerConnectedListener(refreshPeerCount);
      peerDisconnectedSub = BitchatAPI.addPeerDisconnectedListener(refreshPeerCount);
    };

    start();

    return () => {
      messageSub?.remove();
      peerConnectedSub?.remove();
      peerDisconnectedSub?.remove();
      BitchatAPI.stopServices();
    };
  }, [nickname]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    await BitchatAPI.sendMessage(text, [], MESH_CHANNEL);
    setInput('');
  }, [input]);

  if (permissionDenied) {
    return (
      <View style={meshStyles.container}>
        <Text style={meshStyles.header}>Bluetooth permission needed</Text>
        <Text style={meshStyles.subheader}>
          Mesh chat can't scan for nearby devices without it. Enable it for
          this app in your phone's Settings, then reopen the app.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={meshStyles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={meshStyles.header}>
        {started ? `Mesh live as ${nickname}` : 'Starting mesh...'}
      </Text>
      <Text style={meshStyles.subheader}>{peerCount} peer(s) nearby</Text>

      <FlatList
        style={meshStyles.list}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Text style={meshStyles.message}>
            <Text style={meshStyles.sender}>{item.sender}: </Text>
            {item.content}
          </Text>
        )}
      />

      <View style={meshStyles.inputRow}>
        <TextInput
          style={meshStyles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message nearby peers..."
        />
        <TouchableOpacity style={meshStyles.button} onPress={send}>
          <Text style={meshStyles.buttonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const meshStyles = StyleSheet.create({
  container: { flex: 1, padding: 16, paddingTop: 16 },
  header: { fontSize: 16, fontWeight: '600' },
  subheader: { fontSize: 12, color: '#666', marginBottom: 12 },
  list: { flex: 1, marginBottom: 12 },
  message: { paddingVertical: 4 },
  sender: { fontWeight: '600' },
  inputRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  button: {
    backgroundColor: '#1D9E75',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
});

/* =========================================================================
   LOCATION TAB — geohash channel list + channel chat
   ========================================================================= */

function LocationChannelsScreen({ navigation }: any) {
  const [tiers, setTiers] = useState<LocationTier[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Location permission is required to join local channels.');
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setTiers(
        getLocationTiers(position.coords.latitude, position.coords.longitude)
      );
    })();
  }, []);

  if (error) {
    return (
      <View style={locationStyles.center}>
        <Text style={locationStyles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!tiers) {
    return (
      <View style={locationStyles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <FlatList
      contentContainerStyle={locationStyles.list}
      data={tiers}
      keyExtractor={(item) => item.name}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={locationStyles.row}
          onPress={() =>
            navigation.navigate('GeohashChannel', {
              geohash: item.geohash,
              name: item.name,
            })
          }
        >
          <Text style={locationStyles.name}>{item.name}</Text>
          <Text style={locationStyles.meta}>
            #{item.geohash} · ~{item.approxRadiusKm} km
          </Text>
        </TouchableOpacity>
      )}
    />
  );
}

const locationStyles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { textAlign: 'center' },
  list: { padding: 16 },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
  },
  name: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 12, color: '#666', marginTop: 2 },
});

function GeohashChannelScreen({ route }: any) {
  const { geohash, name } = route.params;
  const [messages, setMessages] = useState<Event[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    setMessages([]);
    const unsubscribe = subscribeToGeohash(geohash, (event) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === event.id)) return prev;
        return [...prev, event].sort((a, b) => a.created_at - b.created_at);
      });
    });
    return unsubscribe;
  }, [geohash]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await publishGeohashMessage(geohash, text);
  }, [input, geohash]);

  return (
    <KeyboardAvoidingView
      style={geohashChannelStyles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        style={geohashChannelStyles.list}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Text style={geohashChannelStyles.message}>
            <Text style={geohashChannelStyles.sender}>
              {item.pubkey.slice(0, 8)}:{' '}
            </Text>
            {item.content}
          </Text>
        )}
      />

      <View style={geohashChannelStyles.inputRow}>
        <TextInput
          style={geohashChannelStyles.input}
          value={input}
          onChangeText={setInput}
          placeholder={`Message #${name}...`}
        />
        <TouchableOpacity style={geohashChannelStyles.button} onPress={send}>
          <Text style={geohashChannelStyles.buttonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const geohashChannelStyles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  list: { flex: 1, marginBottom: 12 },
  message: { paddingVertical: 4 },
  sender: { fontWeight: '600' },
  inputRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  button: {
    backgroundColor: '#1D9E75',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
});

/* =========================================================================
   PEERS TAB — nearby peer list + encrypted 1:1 thread
   ========================================================================= */

function PeerListScreen({ navigation }: any) {
  const [peers, setPeers] = useState<Record<string, string>>({});

  useEffect(() => {
    const refresh = async () => {
      const current = await BitchatAPI.getConnectedPeers();
      setPeers(current);
    };
    refresh();

    const connectedSub = BitchatAPI.addPeerConnectedListener(refresh);
    const disconnectedSub = BitchatAPI.addPeerDisconnectedListener(refresh);
    const updatedSub = BitchatAPI.addPeerListUpdatedListener(refresh);

    return () => {
      connectedSub.remove();
      disconnectedSub.remove();
      updatedSub.remove();
    };
  }, []);

  const peerEntries = Object.entries(peers);

  if (peerEntries.length === 0) {
    return (
      <View style={peerListStyles.center}>
        <Text style={peerListStyles.emptyText}>No peers nearby yet</Text>
        <Text style={peerListStyles.emptyHint}>
          Private messages need someone in Bluetooth range
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      contentContainerStyle={peerListStyles.list}
      data={peerEntries}
      keyExtractor={([peerID]) => peerID}
      renderItem={({ item: [peerID, nickname] }) => (
        <TouchableOpacity
          style={peerListStyles.row}
          onPress={() =>
            navigation.navigate('PrivateMessage', { peerID, nickname })
          }
        >
          <Text style={peerListStyles.name}>{nickname}</Text>
          <Text style={peerListStyles.meta}>nearby</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const peerListStyles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { fontSize: 16, fontWeight: '600' },
  emptyHint: { fontSize: 12, color: '#666', marginTop: 4, textAlign: 'center' },
  list: { padding: 16 },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  name: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 12, color: '#666' },
});

type Bubble = BitchatMessage & { outgoing?: boolean };

function PrivateMessageScreen({ route }: any) {
  const { peerID, nickname } = route.params;
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    const messageSub = BitchatAPI.addMessageListener((message: BitchatMessage) => {
      if (message.isPrivate && message.senderPeerID === peerID) {
        setMessages((prev) => [...prev, message]);
      }
    });

    // Caveat: expo-bitchat's delivery/read events only carry the peer's
    // nickname, not a message ID, so there's no exact way to know *which*
    // outgoing message an ack belongs to. This applies each ack to the
    // oldest still-pending message as a best-effort match — fine for a
    // normal back-and-forth, but can misattribute under rapid sends.
    // Nicknames also aren't guaranteed unique between peers.
    const ackSub = BitchatAPI.addDeliveryAckListener((ack) => {
      if (ack.recipientNickname !== nickname) return;
      setMessages((prev) => {
        const idx = prev.findIndex(
          (m) => m.outgoing && m.deliveryStatus?.type === 'sent'
        );
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          deliveryStatus: { type: 'delivered', to: nickname, at: Date.now() },
        };
        return next;
      });
    });

    const readSub = BitchatAPI.addReadReceiptListener((receipt) => {
      if (receipt.readerNickname !== nickname) return;
      setMessages((prev) => {
        const idx = prev.findIndex(
          (m) =>
            m.outgoing &&
            (m.deliveryStatus?.type === 'sent' ||
              m.deliveryStatus?.type === 'delivered')
        );
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          deliveryStatus: { type: 'read', by: nickname, at: Date.now() },
        };
        return next;
      });
    });

    return () => {
      messageSub.remove();
      ackSub.remove();
      readSub.remove();
    };
  }, [peerID, nickname]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');

    const optimistic: Bubble = {
      id: `local-${Date.now()}`,
      sender: nickname,
      content: text,
      timestamp: Date.now(),
      isPrivate: true,
      deliveryStatus: { type: 'sending' },
      outgoing: true,
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      await BitchatAPI.sendPrivateMessage(text, peerID, nickname);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimistic.id ? { ...m, deliveryStatus: { type: 'sent' } } : m
        )
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimistic.id
            ? { ...m, deliveryStatus: { type: 'failed', reason: String(err) } }
            : m
        )
      );
    }
  }, [input, peerID, nickname]);

  const statusLabel = (status?: BitchatMessage['deliveryStatus']) => {
    if (!status) return '';
    switch (status.type) {
      case 'sending':
        return 'sending...';
      case 'sent':
        return 'sent';
      case 'delivered':
        return 'delivered';
      case 'read':
        return 'read';
      case 'failed':
        return 'failed';
    }
  };

  return (
    <KeyboardAvoidingView
      style={privateMessageStyles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={privateMessageStyles.subheader}>encrypted · mesh-only</Text>

      <FlatList
        style={privateMessageStyles.list}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View
            style={[
              privateMessageStyles.bubble,
              item.outgoing ? privateMessageStyles.outgoing : privateMessageStyles.incoming,
            ]}
          >
            <Text
              style={
                item.outgoing
                  ? privateMessageStyles.textOutgoing
                  : privateMessageStyles.textIncoming
              }
            >
              {item.content}
            </Text>
            {item.outgoing && (
              <Text style={privateMessageStyles.status}>
                {statusLabel(item.deliveryStatus)}
              </Text>
            )}
          </View>
        )}
      />

      <View style={privateMessageStyles.inputRow}>
        <TextInput
          style={privateMessageStyles.input}
          value={input}
          onChangeText={setInput}
          placeholder={`Message ${nickname}...`}
        />
        <TouchableOpacity style={privateMessageStyles.button} onPress={send}>
          <Text style={privateMessageStyles.buttonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const privateMessageStyles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  subheader: { fontSize: 12, color: '#666', marginBottom: 12 },
  list: { flex: 1, marginBottom: 12 },
  bubble: { padding: 10, borderRadius: 10, marginVertical: 4, maxWidth: '80%' },
  outgoing: { backgroundColor: '#1D9E75', alignSelf: 'flex-end' },
  incoming: { backgroundColor: '#eee', alignSelf: 'flex-start' },
  textOutgoing: { color: '#fff' },
  textIncoming: { color: '#000' },
  status: { fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 2, textAlign: 'right' },
  inputRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  button: {
    backgroundColor: '#1D9E75',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
});

/* =========================================================================
   NAVIGATION — bottom tabs (Mesh / Location / Peers), each of the
   latter two nesting a stack for their list -> detail screens.
   ========================================================================= */

const LocationStack = createNativeStackNavigator();
function LocationStackScreen() {
  return (
    <LocationStack.Navigator>
      <LocationStack.Screen
        name="LocationChannels"
        component={LocationChannelsScreen}
        options={{ title: 'Location Channels' }}
      />
      <LocationStack.Screen
        name="GeohashChannel"
        component={GeohashChannelScreen}
        options={({ route }: any) => ({ title: `#${route.params.name}` })}
      />
    </LocationStack.Navigator>
  );
}

const PeersStack = createNativeStackNavigator();
function PeersStackScreen() {
  return (
    <PeersStack.Navigator>
      <PeersStack.Screen
        name="PeerList"
        component={PeerListScreen}
        options={{ title: 'Nearby Peers' }}
      />
      <PeersStack.Screen
        name="PrivateMessage"
        component={PrivateMessageScreen}
        options={({ route }: any) => ({ title: route.params.nickname })}
      />
    </PeersStack.Navigator>
  );
}

const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator screenOptions={{ headerShown: false }}>
        <Tab.Screen name="Mesh" component={MeshChatScreen} />
        <Tab.Screen name="Location" component={LocationStackScreen} />
        <Tab.Screen name="Peers" component={PeersStackScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
