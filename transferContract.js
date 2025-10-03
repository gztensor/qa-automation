import { Keyring } from '@polkadot/api';
import { BaseContract, Actor } from './types.js';
import { readFreeBalance, sendTransaction } from './utils.js';
import { getActors, getRegistry } from './actorRegistry.js';

export class TransferContract extends BaseContract {
  constructor(api) {
    const registry = getRegistry();

    super({
      name: "Transfer",
      scope: `balances pallet`,
      deps: { api },
      parameterCount: 3,
      getParameterDesc: async(idx, chosenParameters) => {
        if (idx == 0) {
          const actors = getActors([Actor.Coldkey])
          return {
            name: "actor",
            type: "string",
            selection: "list",
            values: actors,
          };
        } else if (idx == 1) {
          const coldkeyAddresses = Object.values(registry)
            .filter(a => a.type === Actor.Coldkey && a.address)
            .filter(a => a.address !== chosenParameters.actor.address)
            .map(a => a.address);
          return {
            name: "recipient",
            type: "string",
            selection: "list",
            values: coldkeyAddresses,
          };
        } else if (idx == 2) {
          const senderBalance = await readFreeBalance(api, chosenParameters.actor.address);
          const maxAmount = senderBalance / 10n;
          return {
            name: "amount",
            type: "integer",
            selection: "range",
            values: {
              min: maxAmount < 100_000n ? maxAmount : 100_000n,
              max: maxAmount,
            },
          };
        }
      },

      /* ---------------------------- PRECONDITION ---------------------------- */
      precondition: async ({ params }) => {
        const api = this.deps.api;
        const senderBalance = await readFreeBalance(api, params.actor.address);
        const recipientAddress = this.params.recipient;
        const recipientBalance = await readFreeBalance(api, recipientAddress);
        return {
          senderBalanceBefore: senderBalance.toString(),
          recipientBalanceBefore: recipientBalance.toString(),
        };
      },

      /* -------------------------------- ACTION ----------------------------- */
      action: async ({ params }) => {
        const amountStr = String(params.amount);
        const api = this.deps.api;
        let amount = BigInt(amountStr);

        // Real chain call:
        const transfer = api.tx.balances.transferKeepAlive(params.recipient, amount);
        await sendTransaction(api, transfer, params.actor);

        return {
          amount: amount.toString(),
        };
      },

      /* --------------------------- POSTCONDITION --------------------------- */
      postcondition: async ({ params, pre, actionResult }) => {
        const { amount } = actionResult;

        const senderBefore = BigInt(pre.senderBalanceBefore);
        const recipientBefore = BigInt(pre.recipientBalanceBefore);
        const amt = BigInt(amount);

        // Read AFTER balances
        const senderAfter = await readFreeBalance(this.deps.api, params.actor.address);
        const recipientAfter = await readFreeBalance(this.deps.api, params.recipient);

        const senderDelta = senderBefore - senderAfter; // should be >= amt (fees make it larger)
        const recipientDelta = recipientAfter - recipientBefore; // should be == amt

        const recipientOk = recipientDelta === amt;
        const senderOk = senderDelta >= amt; // allow for fees

        return recipientOk && senderOk;
      },
    });
  }
}
