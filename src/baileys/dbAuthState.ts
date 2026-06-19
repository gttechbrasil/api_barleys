import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";
import { prisma } from "../db/prisma";

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function deserialize<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

export async function useDbAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const existing = await prisma.session.findUnique({ where: { id: sessionId } });
  const creds: AuthenticationCreds = existing?.creds
    ? deserialize<AuthenticationCreds>(existing.creds)
    : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const rows = await prisma.authKey.findMany({
          where: { sessionId, category: type, keyId: { in: ids } },
        });
        const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const row of rows) {
          let value = deserialize<any>(row.value);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          result[row.keyId] = value;
        }
        return result;
      },
      set: async (data) => {
        const ops: Promise<unknown>[] = [];
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const entries = data[category];
          if (!entries) continue;
          for (const keyId of Object.keys(entries)) {
            const value = (entries as Record<string, unknown>)[keyId];
            if (value === null || value === undefined) {
              ops.push(
                prisma.authKey
                  .delete({ where: { sessionId_category_keyId: { sessionId, category, keyId } } })
                  .catch(() => undefined)
              );
            } else {
              ops.push(
                prisma.authKey.upsert({
                  where: { sessionId_category_keyId: { sessionId, category, keyId } },
                  create: { sessionId, category, keyId, value: serialize(value) as any },
                  update: { value: serialize(value) as any },
                })
              );
            }
          }
        }
        await Promise.all(ops);
      },
    },
  };

  const saveCreds = async () => {
    await prisma.session.upsert({
      where: { id: sessionId },
      create: { id: sessionId, creds: serialize(state.creds) as any },
      update: { creds: serialize(state.creds) as any },
    });
  };

  return { state, saveCreds };
}

export async function clearAuthState(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}
