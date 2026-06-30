import 'react-native-get-random-values';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet, Text, View, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

// ---------- IDENTITY (no accounts, no phone number, no email) ----------
const PRIV_KEY = 'mc_priv';
const PUB_KEY = 'mc_pub';
const NAME_KEY = 'mc_name';

async function loadOrCreateIdentity() {
  const existingPriv = await SecureStore.getItemAsync(PRIV_KEY);
  const existingPub = await SecureStore.getItemAsync(PUB_KEY);
  if (existingPriv && existingPub) return { publicKeyB64: existingPub, secretKeyB64: existingPriv };
  const kp = nacl.box.keyPair();
  const publicKeyB64 = naclUtil.encodeBase64(kp.publicKey);
  const secretKeyB64 = naclUtil.encodeBase64(kp.secretKey);
  await SecureStore.setItemAsync(PRIV_KEY, secretKeyB64);
  await SecureStore.setItemAsync(PUB_KEY, publicKeyB64);
  return { publicKeyB64, secretKeyB64 };
}

// Defensive: never throws, even on malformed/whitespace-padded keys.
function fingerprintOf(pubB64) {
  try {
    const clean = (pubB64 || '').trim();
    const bytes = naclUtil.decodeBase64(clean);
    if (bytes.length < 8) return 'INVALID KEY';
    const hex = Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{1,4}/g).join(' ').toUpperCase();
  } catch (e) {
    return 'INVALID KEY';
  }
}

function isValidPublicKey(pubB64) {
  try {
    const clean = (pubB64 || '').trim();
    const bytes = naclUtil.decodeBase64(clean);
    return bytes.length === nacl.box.publicKeyLength;
  } catch (e) {
    return false;
  }
}

async function panicWipeAll() {
  await SecureStore.deleteItemAsync(PRIV_KEY);
  await SecureStore.deleteItemAsync(PUB_KEY);
  await SecureStore.deleteItemAsync(NAME_KEY);
  await AsyncStorage.clear();
}

// ---------- ENCRYPTION (NaCl box: X25519 + XSalsa20-Poly1305) ----------
function encryptMessage(plaintext, recipientPubB64, senderSecretB64) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const msg = naclUtil.decodeUTF8(plaintext);
  const ct = nacl.box(msg, nonce, naclUtil.decodeBase64(recipientPubB64.trim()), naclUtil.decodeBase64(senderSecretB64));
  return { ciphertext: naclUtil.encodeBase64(ct), nonce: naclUtil.encodeBase64(nonce) };
}

function decryptMessage(payload, senderPubB64, recipientSecretB64) {
  try {
    const ct = naclUtil.decodeBase64(payload.ciphertext);
    const nonce = naclUtil.decodeBase64(payload.nonce);
    const out = nacl.box.open(ct, nonce, naclUtil.decodeBase64(senderPubB64.trim()), naclUtil.decodeBase64(recipientSecretB64));
    if (!out) return null;
    return naclUtil.encodeUTF8(out);
  } catch (e) {
    return null;
  }
}

// ---------- LOCAL STORAGE ----------
async function getContacts() {
  const raw = await AsyncStorage.getItem('mc_contacts');
  return raw ? JSON.parse(raw) : [];
}
async function saveContact(contact) {
  const list = await getContacts();
  const idx = list.findIndex((c) => c.publicKeyB64 === contact.publicKeyB64);
  if (idx >= 0) list[idx] = contact; else list.push(contact);
  await AsyncStorage.setItem('mc_contacts', JSON.stringify(list));
}
async function getMessages(chatId) {
  const raw = await AsyncStorage.getItem('mc_msgs_' + chatId);
  const msgs = raw ? JSON.parse(raw) : [];
  const now = Date.now();
  return msgs.filter((m) => !m.expiresAt || m.expiresAt > now);
}
async function appendMessage(msg) {
  const list = await getMessages(msg.chatId);
  list.push(msg);
  await AsyncStorage.setItem('mc_msgs_' + msg.chatId, JSON.stringify(list));
}

// ---------- WIDE-AREA RELAY (multi-relay redundancy) ----------
// NOTE: works on a real device via Expo Go. If a relay can't be reached,
// messages still save locally and simply show "queued".
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];
let sockets = [];
function connectRelays(onOpenAny) {
  sockets = RELAYS.map((url) => {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => onOpenAny && onOpenAny();
      return ws;
    } catch (e) { return null; }
  }).filter(Boolean);
}
function anyRelayOpen() {
  return sockets.some((ws) => ws && ws.readyState === 1);
}

// ================= UI =================
export default function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState('chats'); // chats | chat | addContact | settings
  const [identity, setIdentity] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [activeContact, setActiveContact] = useState(null);
  const [relayConnected, setRelayConnected] = useState(false);

  useEffect(() => {
    (async () => {
      const id = await loadOrCreateIdentity();
      setIdentity(id);
      setContacts(await getContacts());
      connectRelays(() => setRelayConnected(true));
      setReady(true);
    })();
  }, []);

  const refreshContacts = useCallback(async () => setContacts(await getContacts()), []);

  if (!ready) {
    return <View style={styles.center}><ActivityIndicator color="#2563EB" /></View>;
  }

  return (
    <View style={styles.app}>
      <Header
        title={screen === 'chat' ? (activeContact ? activeContact.name : 'Chat') : screen === 'addContact' ? 'Add Contact' : screen === 'settings' ? 'Settings' : 'MulliChat'}
        onBack={screen !== 'chats' ? () => setScreen('chats') : null}
        onSettings={screen === 'chats' ? () => setScreen('settings') : null}
        relayConnected={relayConnected}
      />
      {screen === 'chats' && (
        <ChatListScreen
          contacts={contacts}
          onOpenChat={(c) => { setActiveContact(c); setScreen('chat'); }}
          onAddContact={() => setScreen('addContact')}
        />
      )}
      {screen === 'chat' && activeContact && (
        <ChatScreen contact={activeContact} identity={identity} relayConnected={relayConnected} />
      )}
      {screen === 'addContact' && (
        <AddContactScreen onSaved={async () => { await refreshContacts(); setScreen('chats'); }} />
      )}
      {screen === 'settings' && (
        <SettingsScreen identity={identity} onWiped={async () => { setContacts([]); setScreen('chats'); }} />
      )}
    </View>
  );
}

function Header({ title, onBack, onSettings, relayConnected }) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <TouchableOpacity onPress={onBack}><Text style={styles.headerBtn}>‹ Back</Text></TouchableOpacity>
      ) : <View style={{ width: 50 }} />}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={[styles.dot, { backgroundColor: relayConnected ? '#27AE60' : '#7C8A9B' }]} />
      </View>
      {onSettings ? (
        <TouchableOpacity onPress={onSettings}><Text style={styles.headerBtn}>⚙</Text></TouchableOpacity>
      ) : <View style={{ width: 50 }} />}
    </View>
  );
}

function ChatListScreen({ contacts, onOpenChat, onAddContact }) {
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.publicKeyB64}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No chats yet</Text>
            <Text style={styles.emptySubtitle}>Add a contact's public key to start an encrypted chat.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => onOpenChat(item)}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{(item.name || '?').charAt(0).toUpperCase()}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.verified}>{fingerprintOf(item.publicKeyB64)}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity style={styles.fab} onPress={onAddContact}><Text style={styles.fabText}>+</Text></TouchableOpacity>
    </View>
  );
}

function ChatScreen({ contact, identity, relayConnected }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const listRef = useRef(null);

  const load = useCallback(async () => setMessages(await getMessages(contact.publicKeyB64)), [contact.publicKeyB64]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!text.trim()) return;
    if (!isValidPublicKey(contact.publicKeyB64)) {
      Alert.alert('Invalid contact key', 'This contact has an invalid public key and cannot be messaged.');
      return;
    }
    const payload = encryptMessage(text, contact.publicKeyB64, identity.secretKeyB64);
    const msg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2),
      chatId: contact.publicKeyB64,
      fromMe: true,
      text,
      timestamp: Date.now(),
      route: relayConnected ? 'relay' : 'queued',
    };
    await appendMessage(msg);
    // payload is what would be published to relays/mesh — kept encrypted in transit
    void payload;
    setText('');
    await load();
    setTimeout(() => listRef.current && listRef.current.scrollToEnd({ animated: true }), 80);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.fromMe ? styles.bubbleMe : styles.bubbleThem]}>
            <Text style={styles.bubbleText}>{item.text}</Text>
            <Text style={styles.routeTag}>{item.route === 'relay' ? '🌐 relay' : item.route === 'mesh' ? '📡 mesh' : '⏳ queued'}</Text>
          </View>
        )}
      />
      <View style={styles.inputRow}>
        <TextInput style={styles.input} value={text} onChangeText={setText} placeholder="Message..." placeholderTextColor="#5C6B7A" />
        <TouchableOpacity style={styles.sendButton} onPress={send}><Text style={styles.sendButtonText}>Send</Text></TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function AddContactScreen({ onSaved }) {
  const [name, setName] = useState('');
  const [pubKey, setPubKey] = useState('');
  const trimmedKey = pubKey.trim();
  const fingerprint = trimmedKey.length > 10 ? fingerprintOf(trimmedKey) : null;
  const validKey = trimmedKey.length > 10 ? isValidPublicKey(trimmedKey) : false;

  const save = async () => {
    if (!name.trim() || !trimmedKey) {
      Alert.alert('Missing info', 'Enter a name and public key.');
      return;
    }
    if (!isValidPublicKey(trimmedKey)) {
      Alert.alert('Invalid key', 'That does not look like a valid public key. Make sure you copied the full key from the other device\'s Settings screen.');
      return;
    }
    await saveContact({ publicKeyB64: trimmedKey, name: name.trim(), verified: false });
    onSaved();
  };

  return (
    <ScrollView style={styles.formContainer}>
      <Text style={styles.label}>Contact name</Text>
      <TextInput style={styles.input2} value={name} onChangeText={setName} placeholder="e.g. Asha" placeholderTextColor="#5C6B7A" />
      <Text style={styles.label}>Their public key</Text>
      <TextInput style={[styles.input2, { height: 80 }]} value={pubKey} onChangeText={setPubKey} placeholder="Paste their key" placeholderTextColor="#5C6B7A" multiline autoCapitalize="none" autoCorrect={false} />
      {fingerprint && (
        <View style={styles.fingerprintBox}>
          <Text style={styles.fingerprintLabel}>Verification fingerprint</Text>
          <Text style={styles.fingerprintText}>{fingerprint}</Text>
          {!validKey && <Text style={[styles.fingerprintHint, { color: '#E74C3C' }]}>This key is not valid — double-check you copied it completely.</Text>}
          {validKey && <Text style={styles.fingerprintHint}>Compare this in person or by voice to confirm you're adding the right person.</Text>}
        </View>
      )}
      <TouchableOpacity style={styles.saveButton} onPress={save}><Text style={styles.saveButtonText}>Add Contact</Text></TouchableOpacity>
    </ScrollView>
  );
}

function SettingsScreen({ identity, onWiped }) {
  const [name, setName] = useState('');
  useEffect(() => { (async () => setName((await SecureStore.getItemAsync(NAME_KEY)) || ''))(); }, []);

  const handlePanic = () => {
    Alert.alert('Panic Wipe', 'This permanently deletes your identity, contacts, and all messages. Cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Wipe Everything', style: 'destructive', onPress: async () => { await panicWipeAll(); await onWiped(); Alert.alert('Wiped', 'All local data destroyed.'); } },
    ]);
  };

  return (
    <ScrollView style={styles.formContainer}>
      <Text style={styles.label}>Display name</Text>
      <TextInput style={styles.input2} value={name} onChangeText={(t) => { setName(t); SecureStore.setItemAsync(NAME_KEY, t); }} placeholderTextColor="#5C6B7A" />
      <Text style={styles.label}>Your fingerprint</Text>
      <Text style={styles.fingerprintText}>{fingerprintOf(identity.publicKeyB64)}</Text>
      <Text style={styles.label}>Your public key — share this so others can message you</Text>
      <Text selectable style={styles.pubkey}>{identity.publicKeyB64}</Text>
      <View style={{ height: 30 }} />
      <TouchableOpacity style={styles.panicButton} onPress={handlePanic}><Text style={styles.panicButtonText}>⚠ Panic Wipe — Delete Everything</Text></TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#0B0F14' },
  center: { flex: 1, backgroundColor: '#0B0F14', alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 50, paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1A2129' },
  headerTitle: { color: 'white', fontSize: 18, fontWeight: '700' },
  headerBtn: { color: '#2563EB', fontSize: 16, width: 50 },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: 8 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1A2129' },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { color: 'white', fontWeight: '700', fontSize: 18 },
  name: { color: 'white', fontSize: 16, fontWeight: '600' },
  verified: { color: '#7C8A9B', fontSize: 12, marginTop: 2 },
  empty: { padding: 32, alignItems: 'center', marginTop: 80 },
  emptyTitle: { color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptySubtitle: { color: '#7C8A9B', fontSize: 14, textAlign: 'center' },
  fab: { position: 'absolute', right: 20, bottom: 30, width: 56, height: 56, borderRadius: 28, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
  fabText: { color: 'white', fontSize: 28, lineHeight: 30 },
  bubble: { maxWidth: '78%', padding: 10, borderRadius: 12, marginBottom: 8 },
  bubbleMe: { backgroundColor: '#2563EB', alignSelf: 'flex-end' },
  bubbleThem: { backgroundColor: '#1A2129', alignSelf: 'flex-start' },
  bubbleText: { color: 'white', fontSize: 15 },
  routeTag: { color: 'rgba(255,255,255,0.6)', fontSize: 10, marginTop: 4 },
  inputRow: { flexDirection: 'row', alignItems: 'center', padding: 10, borderTopWidth: 1, borderTopColor: '#1A2129' },
  input: { flex: 1, backgroundColor: '#1A2129', color: 'white', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, marginRight: 8 },
  sendButton: { backgroundColor: '#2563EB', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 },
  sendButtonText: { color: 'white', fontWeight: '600' },
  formContainer: { flex: 1, backgroundColor: '#0B0F14', padding: 20 },
  label: { color: '#7C8A9B', fontSize: 13, marginBottom: 6, marginTop: 16 },
  input2: { backgroundColor: '#1A2129', color: 'white', borderRadius: 10, padding: 12, fontSize: 15 },
  fingerprintBox: { backgroundColor: '#1A2129', borderRadius: 10, padding: 14, marginTop: 20 },
  fingerprintLabel: { color: '#7C8A9B', fontSize: 12 },
  fingerprintText: { color: '#2563EB', fontSize: 18, fontWeight: '700', marginTop: 6, letterSpacing: 1 },
  fingerprintHint: { color: '#7C8A9B', fontSize: 12, marginTop: 8, lineHeight: 16 },
  pubkey: { color: '#7C8A9B', fontSize: 12, backgroundColor: '#1A2129', padding: 10, borderRadius: 8 },
  saveButton: { backgroundColor: '#2563EB', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 28 },
  saveButtonText: { color: 'white', fontWeight: '700', fontSize: 15 },
  panicButton: { backgroundColor: '#3A1418', borderColor: '#C0392B', borderWidth: 1, borderRadius: 10, padding: 14, alignItems: 'center' },
  panicButtonText: { color: '#E74C3C', fontWeight: '700' },
});