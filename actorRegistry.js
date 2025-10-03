import { Actor } from './types.js';
import { Keyring } from '@polkadot/api';

const registry = {
  hotkey1:   { type: Actor.Hotkey, seed: '//Charlie' },
  coldkey1:  { type: Actor.Coldkey, seed: '//Alice' },
  hotkey2:   { type: Actor.Hotkey, seed: '//Dave' },
  coldkey2:  { type: Actor.Coldkey, seed: '//Bob' },
  coldkey3:  { type: Actor.Coldkey, seed: '//Eve' },
  spectator: { type: Actor.Spectator },
};

export function getRegistry() {
  const keyring = new Keyring({ type: 'sr25519' });
  keyring.setSS58Format(42);

  const updated = Object.fromEntries(
    Object.entries(registry).map(([key, actor]) => {
      if (actor?.seed) {
        const signer = keyring.addFromUri(actor.seed);
        return [key, { ...actor, address: signer.address }];
      }
      return [key, actor];
    })
  );

  return updated;
}

export function getActors(actorTypes) {
  return Object.values(getRegistry()).filter(a => actorTypes.includes(a.type))
}

/**
 * Find an actor by address and type in the registry.
 * @param {string} address  SS58 address (exact match)
 * @param {any} actorType   e.g., Actor.Hotkey or Actor.Coldkey
 * @returns {{type:any,address?:string,seed?:string}|undefined} the actor object (or undefined if not found)
 */
export function getActorByAddressAndType(address, actorType) {
  const targetAddr = String(address);
  return Object.values(getRegistry()).find(
    (a) => a?.address === targetAddr && a?.type === actorType
  );
}
