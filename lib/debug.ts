import createDebug from "debug";

export const createLogger = (namespace: string) => createDebug(`speicherpilot:${namespace}`);
