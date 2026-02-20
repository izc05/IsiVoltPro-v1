const DB_NAME = "isivolt_legionella_v1";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("ot")) {
        // key: `${tech}|${date}|${code}`
        const store = db.createObjectStore("ot", { keyPath: "key" });
        store.createIndex("byTechDate", ["tech", "date"], { unique: false });
      }
      if (!db.objectStoreNames.contains("history")) {
        // key auto
        const store = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        store.createIndex("byTech", "tech", { unique: false });
        store.createIndex("byTechDate", ["tech", "date"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode="readonly") {
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function dbPutOT(item){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "ot", "readwrite");
    const req = store.put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetOTByTechDate(tech, date){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "ot", "readonly");
    const idx = store.index("byTechDate");
    const req = idx.getAll([tech, date]);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDeleteOTByTechDate(tech, date){
  const db = await openDB();
  const items = await dbGetOTByTechDate(tech, date);
  return new Promise((resolve, reject) => {
    const store = tx(db, "ot", "readwrite");
    let pending = items.length;
    if (!pending) return resolve(true);
    for (const it of items){
      const req = store.delete(it.key);
      req.onsuccess = () => { if (--pending === 0) resolve(true); };
      req.onerror = () => reject(req.error);
    }
  });
}

export async function dbAddHistory(entry){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "history", "readwrite");
    const req = store.add(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetHistoryByTech(tech, limit=200){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "history", "readonly");
    const idx = store.index("byTech");
    const req = idx.getAll(tech);
    req.onsuccess = () => {
      const all = (req.result || []).sort((a,b)=> (b.ts||0)-(a.ts||0));
      resolve(all.slice(0, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dbExportAll(){
  const db = await openDB();
  const dump = {};
  for (const name of ["ot", "history"]){
    dump[name] = await new Promise((resolve, reject) => {
      const store = tx(db, name, "readonly");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  return dump;
}

export async function dbImportAll(dump){
  const db = await openDB();

  // Import simple: añadimos history, y para OT hacemos put.
  if (Array.isArray(dump.history)){
    for (const h of dump.history){
      // quitamos id si viene para que autoIncrement no choque
      const { id, ...rest } = h;
      await dbAddHistory(rest);
    }
  }
  if (Array.isArray(dump.ot)){
    for (const o of dump.ot){
      await dbPutOT(o);
    }
  }
  return true;
}
