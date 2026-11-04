// Chave privada da criptografia neste navegador: IndexedDB "wescc-e2e", guardada como CryptoKey não exportável (nem o
// próprio chat consegue tirar a chave de lá). Sai ao fechar a sessão. Qualquer falha do IndexedDB (aba anônima,
// armazenamento bloqueado) vira "falta a senha" nesta sessão, nunca um erro na tela.

export interface StoredKey {
  privateKey: CryptoKey;
  publicKey: string;
  fingerprint: string;
}

const DB = 'wescc-e2e';
const STORE = 'keys';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function loadKey(userId: string): Promise<StoredKey | null> {
  try {
    const v = (await run('readonly', (s) => s.get(userId))) as StoredKey | undefined;
    return v && v.privateKey && typeof v.fingerprint === 'string' ? v : null;
  } catch {
    return null;
  }
}

export async function saveKey(userId: string, key: StoredKey): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(key, userId));
    return true;
  } catch {
    return false;
  }
}

export async function deleteKey(userId: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(userId));
  } catch {
    // sem IndexedDB: nada guardado
  }
}

// Ao sair da conta: nada da criptografia fica neste navegador.
export async function clearKeystore(): Promise<void> {
  try {
    await run('readwrite', (s) => s.clear());
  } catch {
    // sem IndexedDB: nada guardado
  }
}
