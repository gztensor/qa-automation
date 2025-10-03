export const Actor = Object.freeze({
  Coldkey: 'Coldkey',
  Hotkey: 'Hotkey',
  Spectator: 'Spectator',
  SnOwner: 'SnOwner',
});

export const ACTORS = Object.freeze(Object.values(Actor));

export function isActor(v) {
  return v === Actor.Coldkey || v === Actor.Hotkey || v === Actor.Spectator || v === Actor.SnOwner;
}

export class BaseContract {
  constructor({ 
      name,
      scope, 
      parameterCount,
      getParameterDesc,
      precondition, 
      action, 
      postcondition, 
      deps = {} 
    }) {
    this.name = name;
    this.scope = scope;
    this.precondition = precondition;
    this.parameterCount = parameterCount;
    this.getParameterDesc = getParameterDesc;
    this.action = action;
    this.postcondition = postcondition;
    this.deps = deps;
  }

  async executeFlow({ params } = {}) {
    this.params = params;

    // 2) Precondition
    let pre;
    try {
      pre = await this.precondition({ params: this.params });
    } catch (e) {
      return { ok: false, stage: 'precondition', error: `Precondition error: ${_msg(e)}` };
    }

    // 3) Action
    let actionResult;
    try {
      actionResult = await this.action({ params: this.params });
    } catch (e) {
      return { ok: false, stage: 'action', precondition: pre, params: this.params, error: `Action error: ${_msg(e)}` };
    }

    // 4) Postcondition
    let postOk = false;
    try {
      postOk = await this.postcondition({ params: this.params, pre, actionResult });
    } catch (e) {
      console.log(e);
      return { ok: false, stage: 'postcondition', precondition: pre, params: this.params, actionResult, error: `Postcondition error: ${_msg(e)}` };
    }

    return {
      ok: !!postOk,
      stage: 'done',
      precondition: pre,
      params: this.params,
      actionResult,
      ...(postOk ? {} : { error: 'Postcondition returned false' }),
    };
  }

  /** Convenience factory. */
  static from(cfg) { return new BaseContract(cfg); }
}

/* -------------------------------- Utilities ------------------------------- */
function _msg(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  try { return JSON.stringify(e); } catch { return String(e) }
}

