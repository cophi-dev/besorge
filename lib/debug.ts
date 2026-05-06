import createDebug from "debug";

export const createLogger = (namespace: string) => createDebug(`bessforge:${namespace}`);
