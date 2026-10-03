// Uploaded books, kept in the user's own browser (SPEC_dopa v3 §5.4, SD-W08; ED D-76): the
// original file's bytes, its name and type (this site gives an empty type), under
// `file:<sha256>`. Nothing leaves the browser.
// When IndexedDB cannot be used (private browsing, a full disk), keeping fails quietly: the book
// is read now and is not offered next time.

const DB = "ddr",
  STORE = "files";
let opening = null;

/** The database, opened once (its one store is made at the first visit). */
function open() {
  if (!opening)
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return opening;
}

/** Run one request in a transaction of its own: `action(store)` gives the request; resolves to
 * its result when the transaction is complete. */
async function run(mode, action) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode),
      request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request && request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** The key of a file's bytes: `file:` and the hex SHA-256. */
export async function keyOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "file:" + [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Keep a file; resolves to true when it was kept. */
export async function keep(key, { name, type, bytes }) {
  try {
    await run("readwrite", (store) =>
      store.put({ name, type, size: bytes.byteLength, bytes, addedAt: Date.now() }, key),
    );
    return true;
  } catch {
    return false;
  }
}

/** A kept file { name, type, size, bytes, addedAt }, or null. */
export async function get(key) {
  try {
    return (await run("readonly", (store) => store.get(key))) || null;
  } catch {
    return null;
  }
}

/** The keys of all kept files. */
export async function keys() {
  try {
    return (await run("readonly", (store) => store.getAllKeys())) || [];
  } catch {
    return [];
  }
}

/** Remove a kept file (「一覧から消す」). */
export async function remove(key) {
  try {
    await run("readwrite", (store) => store.delete(key));
  } catch {
    // nothing kept, nothing to remove
  }
}
