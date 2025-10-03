// npm i @polkadot/api
const { ApiPromise, WsProvider } = require('@polkadot/api');

const ENDPOINT = 'wss://entrypoint-finney.opentensor.ai:443';

async function loadActiveNetuids(api) {
  // NetworksAdded: MAP (netuid) -> bool
  const entries = await api.query.subtensorModule.networksAdded.entries();
  const netuids = [];
  for (const [storageKey, isAdded] of entries) {
    if (isAdded.isTrue) {
      const netuid = storageKey.args[0].toNumber();
      netuids.push(netuid);
    }
  }
  // sort for stable output
  netuids.sort((a, b) => a - b);
  return netuids;
}

async function loadKeysMap(api, netuid) {
  // Keys: DMAP (netuid, uid) -> hotkey (AccountId)
  const entries = await api.query.subtensorModule.keys.entries(netuid);

  // Map<number uid, string hotkey>
  const uidToHotkey = new Map();

  for (const [storageKey, accId] of entries) {
    const uid = storageKey.args[1].toNumber(); // [netuid, uid]
    const hotkey = accId.toString(); // SS58
    uidToHotkey.set(uid, hotkey);
  }
  return uidToHotkey;
}

async function loadUidsMap(api, netuid) {
  // Uids: DMAP (netuid, hotkey) -> Option<u16> (uid)
  const entries = await api.query.subtensorModule.uids.entries(netuid);

  // Map<string hotkey, number uid>   (only for Some)
  const hotkeyToUid = new Map();

  for (const [storageKey, optUid] of entries) {
    const hotkey = storageKey.args[1].toString(); // [netuid, hotkey]
    if (optUid.isSome) {
      const uid = optUid.unwrap().toNumber();
      hotkeyToUid.set(hotkey, uid);
    }
  }
  return hotkeyToUid;
}

function checkConsistency(netuid, uidToHotkey, hotkeyToUid) {
  let consistent = true;
  let badPairs = 0;

  const keysSize = uidToHotkey.size;
  const uidsSize = hotkeyToUid.size;

  if (keysSize !== uidsSize) {
    consistent = false;
    console.error(
      `[netuid ${netuid}] SIZE MISMATCH: Keys has ${keysSize}, Uids(Some) has ${uidsSize}`
    );
  }

  // Keys(uid)=hotkey ⇒ Uids(hotkey)=uid
  for (const [uid, hotkey] of uidToHotkey.entries()) {
    const mappedUid = hotkeyToUid.get(hotkey);
    if (mappedUid === undefined) {
      consistent = false;
      badPairs++;
      console.error(
        `[netuid ${netuid}] Missing in Uids: hotkey ${hotkey} for uid ${uid}`
      );
    } else if (mappedUid !== uid) {
      consistent = false;
      badPairs++;
      console.error(
        `[netuid ${netuid}] Mismatch: Keys(${uid})=${hotkey} but Uids(${hotkey})=${mappedUid}`
      );
    }
  }

  // (Optional but useful) Uids(hotkey)=uid ⇒ Keys(uid)=hotkey
  for (const [hotkey, uid] of hotkeyToUid.entries()) {
    const mappedHotkey = uidToHotkey.get(uid);
    if (mappedHotkey === undefined) {
      consistent = false;
      badPairs++;
      console.error(
        `[netuid ${netuid}] Missing in Keys: uid ${uid} for hotkey ${hotkey}`
      );
    } else if (mappedHotkey !== hotkey) {
      consistent = false;
      badPairs++;
      console.error(
        `[netuid ${netuid}] Reverse mismatch: Uids(${hotkey})=${uid} but Keys(${uid})=${mappedHotkey}`
      );
    }
  }

  return { consistent, badPairs, keysSize, uidsSize };
}

async function main() {
  const provider = new WsProvider(ENDPOINT);
  const api = await ApiPromise.create({ provider });
  await api.isReady;
  console.log('Connected to', ENDPOINT);

  try {
    const netuids = await loadActiveNetuids(api);
    console.log('Active netuids:', netuids.join(', '));

    let allGood = true;
    let totalBad = 0;

    for (const netuid of netuids) {
      // If you want to only check a specific netuid (e.g., 104), uncomment:
      // if (netuid !== 104) continue;

      const [uidToHotkey, hotkeyToUid] = await Promise.all([
        loadKeysMap(api, netuid),
        loadUidsMap(api, netuid),
      ]);

      console.log(
        `\n[netuid ${netuid}] Keys=${uidToHotkey.size}, Uids(Some)=${hotkeyToUid.size}`
      );

      const { consistent, badPairs } = checkConsistency(
        netuid,
        uidToHotkey,
        hotkeyToUid
      );

      if (consistent) {
        console.log(`[netuid ${netuid}] ✅ Consistent`);
      } else {
        allGood = false;
        totalBad += badPairs;
        console.error(`[netuid ${netuid}] ❌ Inconsistencies: ${badPairs}`);
      }
    }

    if (allGood) {
      console.log('\n✅ All checked netuids are consistent.');
    } else {
      console.error(`\n❌ Found inconsistencies across networks. Total issues: ${totalBad}`);
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await api.disconnect();
  }
}

main().catch(console.error);
