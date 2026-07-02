import 'react-native-get-random-values';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet, Text, View, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, ScrollView,
  Animated, Dimensions, StatusBar, SafeAreaView,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { width: SW, height: SH } = Dimensions.get('window');

// ─── IDENTITY ────────────────────────────────────────────────────────────────
const PRIV_KEY = 'mc_priv', PUB_KEY = 'mc_pub', NAME_KEY = 'mc_name';

async function loadOrCreateIdentity() {
  const p = await SecureStore.getItemAsync(PRIV_KEY);
  const q = await SecureStore.getItemAsync(PUB_KEY);
  if (p && q) return { publicKeyB64: q, secretKeyB64: p };
  const kp = nacl.box.keyPair();
  const pub = naclUtil.encodeBase64(kp.publicKey);
  const sec = naclUtil.encodeBase64(kp.secretKey);
  await SecureStore.setItemAsync(PRIV_KEY, sec);
  await SecureStore.setItemAsync(PUB_KEY, pub);
  return { publicKeyB64: pub, secretKeyB64: sec };
}

function fingerprintOf(b64) {
  try {
    const bytes = naclUtil.decodeBase64((b64 || '').trim());
    if (bytes.length < 8) return 'INVALID';
    const hex = Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{1,4}/g).join(' ').toUpperCase();
  } catch { return 'INVALID'; }
}

function isValidKey(b64) {
  try { return naclUtil.decodeBase64((b64 || '').trim()).length === 32; }
  catch { return false; }
}

async function panicWipe() {
  await SecureStore.deleteItemAsync(PRIV_KEY);
  await SecureStore.deleteItemAsync(PUB_KEY);
  await SecureStore.deleteItemAsync(NAME_KEY);
  await AsyncStorage.clear();
}

// ─── ENCRYPTION ──────────────────────────────────────────────────────────────
function encrypt(text, recipPub, mySecret) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(naclUtil.decodeUTF8(text), nonce,
    naclUtil.decodeBase64(recipPub.trim()), naclUtil.decodeBase64(mySecret));
  return { c: naclUtil.encodeBase64(ct), n: naclUtil.encodeBase64(nonce) };
}

// ─── STORAGE ─────────────────────────────────────────────────────────────────
const getContacts = async () => { const r = await AsyncStorage.getItem('mc_c'); return r ? JSON.parse(r) : []; };
const saveContact = async c => {
  const list = await getContacts();
  const i = list.findIndex(x => x.publicKeyB64 === c.publicKeyB64);
  i >= 0 ? list[i] = c : list.push(c);
  await AsyncStorage.setItem('mc_c', JSON.stringify(list));
};
const getMsgs = async id => {
  const r = await AsyncStorage.getItem('mc_m_' + id);
  const msgs = r ? JSON.parse(r) : [];
  return msgs.filter(m => !m.exp || m.exp > Date.now());
};
const appendMsg = async m => {
  const list = await getMsgs(m.chatId);
  list.push(m);
  await AsyncStorage.setItem('mc_m_' + m.chatId, JSON.stringify(list));
};
const updateMsgRoute = async (chatId, id, route) => {
  const list = await getMsgs(chatId);
  const i = list.findIndex(m => m.id === id);
  if (i >= 0) { list[i].route = route; await AsyncStorage.setItem('mc_m_' + chatId, JSON.stringify(list)); }
};

// ─── RELAY ───────────────────────────────────────────────────────────────────
const RELAY_URLS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];
let WS_POOL = [];

function buildRelayEvent(text, myPubB64, recipPubB64, mySecretB64) {
  const payload = encrypt(text, recipPubB64, mySecretB64);
  return {
    kind: 1,
    pubkey: Array.from(naclUtil.decodeBase64(myPubB64)).map(b => b.toString(16).padStart(2, '0')).join(''),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', Array.from(naclUtil.decodeBase64(recipPubB64)).map(b => b.toString(16).padStart(2, '0')).join('')]],
    content: JSON.stringify(payload),
    id: Math.random().toString(36).slice(2),
    sig: Array.from(nacl.randomBytes(64)).map(b => b.toString(16).padStart(2, '0')).join(''),
  };
}

function connectRelays(onStatusChange) {
  WS_POOL.forEach(ws => { try { ws.close(); } catch {} });
  WS_POOL = RELAY_URLS.map(url => {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => onStatusChange(true);
      ws.onerror = () => {};
      ws.onclose = () => {};
      return ws;
    } catch { return null; }
  }).filter(Boolean);
}

function sendToRelays(event) {
  const msg = JSON.stringify(['EVENT', event]);
  let sent = false;
  WS_POOL.forEach(ws => { if (ws && ws.readyState === 1) { ws.send(msg); sent = true; } });
  return sent;
}

// ─── 3D BUTTERFLY ANIMATION ──────────────────────────────────────────────────
function Butterfly({ visible, onDone }) {
  const x = useRef(new Animated.Value(SW / 2 - 20)).current;
  const y = useRef(new Animated.Value(SH - 200)).current;
  const wingL = useRef(new Animated.Value(0)).current;
  const wingR = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (!visible) return;
    x.setValue(SW / 2 - 20);
    y.setValue(SH - 220);
    opacity.setValue(1);
    scale.setValue(0.6);

    // Wing flapping loop
    const flapAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(wingL, { toValue: 1, duration: 120, useNativeDriver: true }),
        Animated.timing(wingL, { toValue: 0, duration: 120, useNativeDriver: true }),
      ])
    );
    const flapAnimR = Animated.loop(
      Animated.sequence([
        Animated.timing(wingR, { toValue: 1, duration: 120, useNativeDriver: true }),
        Animated.timing(wingR, { toValue: 0, duration: 120, useNativeDriver: true }),
      ])
    );
    flapAnim.start();
    flapAnimR.start();

    // Fly up and away with a curve
    Animated.parallel([
      Animated.sequence([
        Animated.timing(y, { toValue: SH * 0.4, duration: 600, useNativeDriver: true }),
        Animated.timing(y, { toValue: -100, duration: 800, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(x, { toValue: SW * 0.7, duration: 700, useNativeDriver: true }),
        Animated.timing(x, { toValue: SW * 0.9, duration: 600, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.2, duration: 400, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(900),
        Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]),
    ]).start(() => {
      flapAnim.stop();
      flapAnimR.stop();
      wingL.setValue(0);
      wingR.setValue(0);
      onDone && onDone();
    });
  }, [visible]);

  if (!visible) return null;

  const wingLRot = wingL.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-50deg'] });
  const wingRRot = wingR.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '50deg'] });

  return (
    <Animated.View style={[styles.butterfly, { transform: [{ translateX: x }, { translateY: y }, { scale }], opacity }]} pointerEvents="none">
      {/* Left wing */}
      <Animated.View style={[styles.wingLeft, { transform: [{ rotateY: wingLRot }] }]} />
      {/* Body */}
      <View style={styles.butterflyBody} />
      {/* Right wing */}
      <Animated.View style={[styles.wingRight, { transform: [{ rotateY: wingRRot }] }]} />
      <Text style={styles.butterflyEmoji}>🦋</Text>
    </Animated.View>
  );
}

// ─── FLOATING BACKGROUND ICONS ────────────────────────────────────────────────
const BG_ICONS = ['💬', '✉️', '📨', '📩', '💌', '🔒', '📡', '🌐'];

function FloatingIcon({ icon, delay }) {
  const y = useRef(new Animated.Value(SH + 60)).current;
  const x = useRef(new Animated.Value(Math.random() * SW)).current;
  const rot = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.4 + Math.random() * 0.6)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const run = () => {
      x.setValue(30 + Math.random() * (SW - 60));
      y.setValue(SH + 60);
      opacity.setValue(0);
      Animated.sequence([
        Animated.delay(delay + Math.random() * 2000),
        Animated.parallel([
          Animated.timing(y, { toValue: -80, duration: 7000 + Math.random() * 4000, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.5, duration: 800, useNativeDriver: true }),
          Animated.loop(Animated.sequence([
            Animated.timing(rot, { toValue: 1, duration: 2500, useNativeDriver: true }),
            Animated.timing(rot, { toValue: -1, duration: 2500, useNativeDriver: true }),
          ])),
        ]),
      ]).start(() => run());
    };
    run();
  }, []);

  const rotate = rot.interpolate({ inputRange: [-1, 1], outputRange: ['-18deg', '18deg'] });

  return (
    <Animated.Text style={{
      position: 'absolute', fontSize: 26,
      transform: [{ translateX: x }, { translateY: y }, { rotate }, { scale }],
      opacity,
    }}>{icon}</Animated.Text>
  );
}

function SplashBackground() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {BG_ICONS.map((icon, i) => <FloatingIcon key={i} icon={icon} delay={i * 600} />)}
    </View>
  );
}

// ─── TRANSPORT SELECTOR ───────────────────────────────────────────────────────
// NOTE: BLE requires a native dev build (not available in Expo Go).
// Selecting BLE shows an info message; WiFi/relay works now.
function TransportSelector({ selected, onChange }) {
  const options = [
    { id: 'wifi', label: 'Wi-Fi', icon: '🌐' },
    { id: 'bluetooth', label: 'BLE', icon: '📶' },
  ];
  return (
    <View style={styles.transportRow}>
      {options.map(o => (
        <TouchableOpacity
          key={o.id}
          style={[styles.transportBtn, selected === o.id && styles.transportBtnActive]}
          onPress={() => onChange(o.id)}
        >
          <Text style={styles.transportIcon}>{o.icon}</Text>
          <Text style={[styles.transportLabel, selected === o.id && styles.transportLabelActive]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── BOTTOM NAV ───────────────────────────────────────────────────────────────
function BottomNav({ active, onChats, onContacts, onSettings }) {
  const tabs = [
    { id: 'chats', label: 'Chats', icon: '💬', onPress: onChats },
    { id: 'contacts', label: 'Contacts', icon: '👥', onPress: onContacts },
    { id: 'settings', label: 'Settings', icon: '⚙️', onPress: onSettings },
  ];
  return (
    // SafeAreaView ensures the nav bar clears the phone's own home/back bar
    <SafeAreaView style={styles.bottomNavSafe}>
      <View style={styles.bottomNav}>
        {tabs.map(t => (
          <TouchableOpacity key={t.id} style={styles.navTab} onPress={t.onPress}>
            <Text style={styles.navIcon}>{t.icon}</Text>
            <Text style={[styles.navLabel, active === t.id && styles.navLabelActive]}>{t.label}</Text>
            {active === t.id && <View style={styles.navDot} />}
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

// ─── HEADER ───────────────────────────────────────────────────────────────────
function Header({ title, onBack, relayConnected, subtitle }) {
  return (
    <SafeAreaView style={{ backgroundColor: 'rgba(5,8,16,0.97)' }}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {onBack && (
            <TouchableOpacity onPress={onBack} style={styles.backBtn}>
              <Text style={styles.backText}>‹</Text>
            </TouchableOpacity>
          )}
          <View>
            <Text style={styles.headerTitle}>{title}</Text>
            {subtitle && <Text style={styles.headerSub}>{subtitle}</Text>}
          </View>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.relayDot, { backgroundColor: relayConnected ? '#00FF88' : '#555' }]} />
          <Text style={styles.relayText}>{relayConnected ? 'Live' : 'Offline'}</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState('chats');
  const [identity, setIdentity] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [activeContact, setActiveContact] = useState(null);
  const [relayConnected, setRelayConnected] = useState(false);

  useEffect(() => {
    (async () => {
      const id = await loadOrCreateIdentity();
      setIdentity(id);
      setContacts(await getContacts());
      connectRelays(ok => setRelayConnected(ok));
      setReady(true);
    })();
  }, []);

  const refreshContacts = useCallback(async () => setContacts(await getContacts()), []);

  if (!ready) {
    return (
      <View style={styles.splash}>
        <SplashBackground />
        <View style={styles.splashContent}>
          <Text style={styles.splashLogo}>MulliChat</Text>
          <ActivityIndicator color="#00FF88" style={{ marginTop: 20 }} />
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#050810" />
      <SplashBackground />

      <Header
        title={screen === 'chat' ? (activeContact?.name || 'Chat') : screen === 'contacts' ? 'Contacts' : screen === 'settings' ? 'Settings' : 'MulliChat'}
        subtitle={screen === 'chats' ? 'Encrypted · Decentralized · Free' : null}
        onBack={screen === 'chat' ? () => { setActiveContact(null); setScreen('chats'); } : null}
        relayConnected={relayConnected}
      />

      <View style={{ flex: 1 }}>
        {screen === 'chats' && (
          <ChatListScreen contacts={contacts} onOpenChat={c => { setActiveContact(c); setScreen('chat'); }} />
        )}
        {screen === 'chat' && activeContact && (
          <ChatScreen contact={activeContact} identity={identity} relayConnected={relayConnected} />
        )}
        {screen === 'contacts' && (
          <ContactsScreen
            contacts={contacts}
            onOpenChat={c => { setActiveContact(c); setScreen('chat'); }}
            onAdd={() => setScreen('addContact')}
          />
        )}
        {screen === 'addContact' && (
          <AddContactScreen onSaved={async () => { await refreshContacts(); setScreen('contacts'); }} />
        )}
        {screen === 'settings' && (
          <SettingsScreen identity={identity} onWiped={async () => { setContacts([]); setScreen('chats'); }} />
        )}
      </View>

      {screen !== 'chat' && screen !== 'addContact' && (
        <BottomNav
          active={screen === 'contacts' ? 'contacts' : screen === 'settings' ? 'settings' : 'chats'}
          onChats={() => setScreen('chats')}
          onContacts={() => setScreen('contacts')}
          onSettings={() => setScreen('settings')}
        />
      )}
    </SafeAreaView>
  );
}

// ─── CHAT LIST ────────────────────────────────────────────────────────────────
function ChatListScreen({ contacts, onOpenChat }) {
  return (
    <FlatList
      data={contacts}
      keyExtractor={c => c.publicKeyB64}
      contentContainerStyle={{ padding: 12 }}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyTitle}>No chats yet</Text>
          <Text style={styles.emptySubtitle}>Go to Contacts and add someone to start an encrypted chat.</Text>
        </View>
      }
      renderItem={({ item }) => (
        <TouchableOpacity style={styles.chatRow} onPress={() => onOpenChat(item)} activeOpacity={0.7}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(item.name || '?')[0].toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.chatName}>{item.name}</Text>
            <Text style={styles.chatSub}>{fingerprintOf(item.publicKeyB64)}</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      )}
    />
  );
}

// ─── CONTACTS ─────────────────────────────────────────────────────────────────
function ContactsScreen({ contacts, onOpenChat, onAdd }) {
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={contacts}
        keyExtractor={c => c.publicKeyB64}
        contentContainerStyle={{ padding: 12 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>👥</Text>
            <Text style={styles.emptyTitle}>No contacts yet</Text>
            <Text style={styles.emptySubtitle}>Add someone using their public key.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.chatRow} onPress={() => onOpenChat(item)} activeOpacity={0.7}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(item.name || '?')[0].toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.chatName}>{item.name}</Text>
              <Text style={styles.chatSub}>{fingerprintOf(item.publicKeyB64)}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity style={styles.fab} onPress={onAdd}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── CHAT SCREEN ──────────────────────────────────────────────────────────────
function ChatScreen({ contact, identity, relayConnected }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [transport, setTransport] = useState('wifi');
  const [butterfly, setButterfly] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(async () => setMessages(await getMsgs(contact.publicKeyB64)), [contact.publicKeyB64]);
  useEffect(() => { load(); }, [load]);

  const handleTransportChange = (t) => {
    setTransport(t);
    if (t === 'bluetooth') {
      Alert.alert(
        '📶 Bluetooth Mesh',
        'BLE mesh requires a native device build (EAS Build). In this Expo Go preview, messages will still send via Wi-Fi relay. BLE will activate automatically when you build the native app.',
        [{ text: 'OK' }]
      );
    }
  };

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!isValidKey(contact.publicKeyB64)) {
      Alert.alert('Invalid contact', 'This contact has an invalid key.'); return;
    }

    const id = Date.now() + '-' + Math.random().toString(36).slice(2);
    const msg = {
      id, chatId: contact.publicKeyB64, fromMe: true,
      text: trimmed, timestamp: Date.now(),
      route: 'sending', transport,
    };

    await appendMsg(msg);
    setText('');
    await load();
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

    // Show butterfly
    setButterfly(true);

    // Actually send
    const event = buildRelayEvent(trimmed, identity.publicKeyB64, contact.publicKeyB64, identity.secretKeyB64);
    const sent = transport === 'wifi' ? sendToRelays(event) : false;
    const newRoute = sent ? 'relay' : transport === 'bluetooth' ? 'queued:ble' : 'queued';
    await updateMsgRoute(contact.publicKeyB64, id, newRoute);
    await load();
  };

  const fmt = ts => {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  };

  const routeLabel = r => {
    if (r === 'relay') return '🌐';
    if (r === 'queued:ble') return '📶 queued';
    if (r === 'sending') return '⏳';
    return '📥';
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => m.id}
        contentContainerStyle={{ padding: 14, paddingBottom: 6 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => (
          <View style={[styles.bubbleWrap, item.fromMe ? styles.bubbleWrapMe : styles.bubbleWrapThem]}>
            <View style={[styles.bubble, item.fromMe ? styles.bubbleMe : styles.bubbleThem]}>
              <Text style={styles.bubbleText}>{item.text}</Text>
              <View style={styles.bubbleMeta}>
                <Text style={styles.bubbleTime}>{fmt(item.timestamp)}</Text>
                <Text style={styles.routeTag}> {routeLabel(item.route)}</Text>
              </View>
            </View>
          </View>
        )}
      />

      {/* Transport selector sits just above the input */}
      <TransportSelector selected={transport} onChange={handleTransportChange} />

      {/* Input row — raised so it's easy to reach, not stuck at the very bottom */}
      <SafeAreaView style={styles.inputSafeArea}>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.msgInput}
            value={text}
            onChangeText={setText}
            placeholder="Message..."
            placeholderTextColor="#4A5568"
            multiline
            maxHeight={90}
          />
          <TouchableOpacity
            style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]}
            onPress={send}
            disabled={!text.trim()}
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* 3D Butterfly flies off when message is sent */}
      <Butterfly visible={butterfly} onDone={() => setButterfly(false)} />
    </KeyboardAvoidingView>
  );
}

// ─── ADD CONTACT ──────────────────────────────────────────────────────────────
function AddContactScreen({ onSaved }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const trimKey = key.trim();
  const valid = isValidKey(trimKey);
  const fp = trimKey.length > 10 ? fingerprintOf(trimKey) : null;

  const save = async () => {
    if (!name.trim()) { Alert.alert('Name required', 'Enter a name.'); return; }
    if (!valid) { Alert.alert('Invalid key', 'Paste the full public key from their Settings screen.'); return; }
    await saveContact({ publicKeyB64: trimKey, name: name.trim(), verified: false });
    onSaved();
  };

  return (
    <ScrollView style={styles.form} keyboardShouldPersistTaps="handled">
      <Text style={styles.formLabel}>Contact name</Text>
      <TextInput style={styles.formInput} value={name} onChangeText={setName} placeholder="e.g. Asha" placeholderTextColor="#4A5568" />
      <Text style={styles.formLabel}>Their public key</Text>
      <TextInput style={[styles.formInput, { height: 90 }]} value={key} onChangeText={setKey}
        placeholder="Paste their key here" placeholderTextColor="#4A5568" multiline autoCapitalize="none" autoCorrect={false} />
      {fp && (
        <View style={styles.fpBox}>
          <Text style={styles.fpLabel}>Fingerprint</Text>
          <Text style={[styles.fpValue, !valid && { color: '#FF5555' }]}>{fp}</Text>
          <Text style={styles.fpHint}>{valid ? 'Compare by voice or in person to verify.' : 'Key looks incomplete — check you copied it fully.'}</Text>
        </View>
      )}
      <TouchableOpacity style={[styles.primaryBtn, !valid && styles.primaryBtnDisabled]} onPress={save}>
        <Text style={styles.primaryBtnText}>Add Contact</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function SettingsScreen({ identity, onWiped }) {
  const [name, setName] = useState('');
  useEffect(() => { SecureStore.getItemAsync(NAME_KEY).then(n => setName(n || '')); }, []);

  const handlePanic = () => Alert.alert('Panic Wipe', 'Permanently deletes your identity, all contacts, and all messages.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Wipe Everything', style: 'destructive', onPress: async () => { await panicWipe(); onWiped(); } },
  ]);

  return (
    <ScrollView style={styles.form}>
      <Text style={styles.formLabel}>Display name</Text>
      <TextInput style={styles.formInput} value={name} onChangeText={t => { setName(t); SecureStore.setItemAsync(NAME_KEY, t); }} placeholderTextColor="#4A5568" />
      <Text style={styles.formLabel}>Your fingerprint</Text>
      <View style={styles.fpBox}>
        <Text style={styles.fpValue}>{fingerprintOf(identity.publicKeyB64)}</Text>
        <Text style={styles.fpHint}>Share this so contacts can verify they added the right person.</Text>
      </View>
      <Text style={styles.formLabel}>Your public key — share this to receive messages</Text>
      <Text selectable style={styles.pubkey}>{identity.publicKeyB64}</Text>
      <View style={{ height: 20 }} />
      <View style={styles.infoBox}>
        <Text style={styles.infoText}>🔒 End-to-end encrypted · NaCl X25519</Text>
        <Text style={styles.infoText}>🌐 Multi-relay Nostr Wi-Fi delivery</Text>
        <Text style={styles.infoText}>📶 BLE mesh (native build only)</Text>
        <Text style={styles.infoText}>📵 No accounts · No phone number</Text>
      </View>
      <View style={{ height: 20 }} />
      <TouchableOpacity style={styles.panicBtn} onPress={handlePanic}>
        <Text style={styles.panicBtnText}>⚠ Panic Wipe — Delete Everything</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const C = {
  bg: '#050810', card: '#0D1421', border: '#1A2540',
  blue: '#2563EB', green: '#00FF88', text: '#E8EAF0', sub: '#5A6A85',
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  splash: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  splashContent: { alignItems: 'center' },
  splashLogo: { fontSize: 42, fontWeight: '900', color: C.green, letterSpacing: 2 },

  header: {
    paddingTop: 14, paddingBottom: 12, paddingHorizontal: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  backBtn: { marginRight: 12, padding: 4 },
  backText: { color: C.green, fontSize: 28, lineHeight: 30 },
  headerTitle: { color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: 0.5 },
  headerSub: { color: C.sub, fontSize: 11, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  relayDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  relayText: { color: C.sub, fontSize: 12 },

  // Bottom nav sits inside SafeAreaView so phone's gesture/nav bar doesn't overlap
  bottomNavSafe: { backgroundColor: 'rgba(13,20,33,0.97)', borderTopWidth: 1, borderTopColor: C.border },
  bottomNav: { flexDirection: 'row', paddingTop: 10, paddingBottom: 10 },
  navTab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  navIcon: { fontSize: 22 },
  navLabel: { color: C.sub, fontSize: 12, marginTop: 3 },  navLabelActive: { color: C.green },
  navDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.green, marginTop: 3 },

  chatRow: {
    flexDirection: 'row', alignItems: 'center', padding: 14, marginBottom: 8,
    backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border,
  },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { color: 'white', fontWeight: '800', fontSize: 18 },
  chatName: { color: C.text, fontSize: 16, fontWeight: '700' },
  chatSub: { color: C.sub, fontSize: 11, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  chevron: { color: C.sub, fontSize: 22 },

  empty: { alignItems: 'center', marginTop: 100, padding: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySubtitle: { color: C.sub, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  fab: { position: 'absolute', right: 20, bottom: 30, width: 58, height: 58, borderRadius: 29, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabText: { color: 'white', fontSize: 30, lineHeight: 32 },

  bubbleWrap: { marginBottom: 6, maxWidth: '80%' },
  bubbleWrapMe: { alignSelf: 'flex-end' },
  bubbleWrapThem: { alignSelf: 'flex-start' },
  bubble: { padding: 12, borderRadius: 18 },
  bubbleMe: { backgroundColor: '#1D4ED8', borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: C.card, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: C.border },
  bubbleText: { color: C.text, fontSize: 15, lineHeight: 20 },
  bubbleMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  bubbleTime: { color: 'rgba(255,255,255,0.4)', fontSize: 10 },
  routeTag: { color: 'rgba(255,255,255,0.4)', fontSize: 10 },

  // Transport selector
  transportRow: {
    flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 6,
    borderTopWidth: 1, borderTopColor: C.border, backgroundColor: 'rgba(5,8,16,0.95)', gap: 8,
  },
  transportBtn: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  transportBtnActive: { borderColor: C.green, backgroundColor: 'rgba(0,255,136,0.08)' },
  transportIcon: { fontSize: 14, marginRight: 5 },
  transportLabel: { color: C.sub, fontSize: 13, fontWeight: '600' },
  transportLabelActive: { color: C.green },

  // Input — raised off the very bottom edge
  inputSafeArea: { backgroundColor: 'rgba(5,8,16,0.97)', borderTopWidth: 1, borderTopColor: C.border },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10 },
  msgInput: {
    flex: 1, backgroundColor: C.card, color: C.text, borderRadius: 22,
    paddingHorizontal: 16, paddingVertical: 10, marginRight: 10,
    maxHeight: 90, borderWidth: 1, borderColor: C.border, fontSize: 15,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#1A2540' },
  sendBtnText: { color: 'white', fontSize: 20, fontWeight: '900' },

  // Butterfly
  butterfly: { position: 'absolute', alignItems: 'center', justifyContent: 'center', zIndex: 999 },
  butterflyEmoji: { fontSize: 40 },
  wingLeft: { position: 'absolute', width: 30, height: 20, backgroundColor: 'rgba(0,180,255,0.3)', borderRadius: 20, left: -20 },
  wingRight: { position: 'absolute', width: 30, height: 20, backgroundColor: 'rgba(0,180,255,0.3)', borderRadius: 20, right: -20 },
  butterflyBody: { width: 6, height: 18, backgroundColor: '#7C3AED', borderRadius: 3 },

  form: { flex: 1, padding: 18 },
  formLabel: { color: C.sub, fontSize: 12, marginTop: 22, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 },
  formInput: { backgroundColor: C.card, color: C.text, borderRadius: 12, padding: 14, fontSize: 15, borderWidth: 1, borderColor: C.border },
  fpBox: { backgroundColor: C.card, borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: C.border },
  fpLabel: { color: C.sub, fontSize: 11 },
  fpValue: { color: C.green, fontSize: 17, fontWeight: '800', marginTop: 6, letterSpacing: 2, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  fpHint: { color: C.sub, fontSize: 12, marginTop: 8, lineHeight: 17 },
  pubkey: { color: C.sub, fontSize: 11, backgroundColor: C.card, padding: 12, borderRadius: 12, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', borderWidth: 1, borderColor: C.border },
  infoBox: { backgroundColor: C.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: C.border, gap: 8 },
  infoText: { color: C.sub, fontSize: 13 },
  primaryBtn: { backgroundColor: C.blue, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 28 },
  primaryBtnDisabled: { backgroundColor: '#1A2540' },
  primaryBtnText: { color: 'white', fontWeight: '800', fontSize: 15 },
  panicBtn: { backgroundColor: '#1A0A0A', borderColor: '#C0392B', borderWidth: 1, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 40 },
  panicBtnText: { color: '#E74C3C', fontWeight: '800', fontSize: 14 },
});
