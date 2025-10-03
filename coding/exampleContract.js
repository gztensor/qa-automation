import { Keyring } from '@polkadot/api';
import { BaseContract, Actor } from './types.js';
import { readFreeBalance, sendTransaction } from './utils.js';
import { registry } from './actorRegistry.js';

export class ExampleContract extends BaseContract {
  static checkActorType(actor) {
    return (actor.type == Actor.Coldkey)
  }
  constructor(api, actor) {
    super({
      actor,
      name: "Transfer",
      description: `Transfer TAO from a coldkey to a recipient.`,
      deps: { api },
      collectContext: () => {
        return {}
      },
      parameterCount: 2,
      getParameterDesc: async(idx, chosenParameters) => {
        if (idx == 0) {
          const coldkeyAddresses = Object.values(registry)
            .filter(a => a.type === Actor.Coldkey && a.address)
            .filter(a => a.address !== actor.address)
            .map(a => `'${a.address}'`)
            .join(', ');
          return {
            name: "recipient",
            type: "string",
            values: coldkeyAddresses,
            guidance: ""
          };
        } else if (idx == 1) {
          const senderBalance = actor.address
            ? await readFreeBalance(api, actor.address)
            : null;
          const recipientBalance = await readFreeBalance(api, chosenParameters.recipient);
          return {
            name: "amount",
            type: "integer number",
            values: `From 0 to ${senderBalance}`,
            guidance: `
              Amounts start to have meaningful value starting from 100000000.
              Smaller amounts can be used to test edge cases.
              Recipient balance is currently ${recipientBalance}.
            `,
          };
        }
      },

      /* ---------------------------- PRECONDITION ---------------------------- */
      precondition: async ({ actor }) => {
        const api = this.deps.api;

        // sender balance now
        const senderBalance = actor.address
          ? await readFreeBalance(api, actor.address)
          : null;

        const recipientAddress = this.params.recipient;
        const recipientBalance = await readFreeBalance(api, recipientAddress);

        // Put values into `data` so the prompt (and logs) can see them
        return {
          can_execute: true,
          data: {
            senderAddress: actor.address ?? null,
            recipientAddress,
            senderBalanceBefore: senderBalance?.toString() ?? null,
            recipientBalanceBefore: recipientBalance?.toString() ?? null,
          },
        };
      },

      /* -------------------------------- ACTION ----------------------------- */
      action: async ({ actor, params }) => {
        if (!params || typeof params.recipient !== 'string' || !params.recipient.trim()) {
          return { error: 'Invalid params: "recipient" is required' };
        }
        const amountStr = String(params.amount ?? '').trim();
        if (!amountStr) return { error: 'Invalid params: "amount" is required' };

        const api = this.deps.api;

        let amount;
        try { amount = BigInt(amountStr); }
        catch { return { error: 'Invalid "amount": must be integer-like' }; }

        if (amount <= 0n) return { error: '"amount" must be > 0' };
        if (!actor.address) return { error: 'Actor has no address' };

        // Real chain call:
        const transfer = api.tx.balances.transferKeepAlive(params.recipient, amount);

        // Sign and send the transaction
        const keyring = new Keyring({ type: 'sr25519' });
        const sender = keyring.addFromUri(actor.seed);
        await sendTransaction(api, transfer, sender);

        return {
          amount: amount.toString(),
        };
      },

      /* --------------------------- POSTCONDITION --------------------------- */
      postcondition: async ({ pre, actionResult, deps }) => {
        const { amount } = actionResult;

        const senderBefore = BigInt(pre.data.senderBalanceBefore);
        const recipientBefore = BigInt(pre.data.recipientBalanceBefore);
        const amt = BigInt(amount);

        // Read AFTER balances
        const senderAfter = await readFreeBalance(deps.api, pre.data.senderAddress);
        const recipientAfter = await readFreeBalance(deps.api, pre.data.recipientAddress);

        const senderDelta = senderBefore - senderAfter;       // should be >= amt (fees make it larger)
        const recipientDelta = recipientAfter - recipientBefore; // should be == amt

        const recipientOk = recipientDelta === amt;
        const senderOk = senderDelta >= amt; // allow for fees

        return recipientOk && senderOk;
      },
    });
  }
}
