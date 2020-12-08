import Stream from "stream";
import * as fs from 'fs';
import {promisify} from 'util';
import * as path from "path";
import store from "./store";
import {SocketMessage} from "../interfaces/SocketMessage";
import errors from "./errors";

const csvFields = ['tstamp', 'date', 'rssi', 'len', 'cnt', 'dc', 'flags', 'type', 'fromAddr', 'toAddr', 'fromName', 'toName', 'fromSerial', 'toSerial', 'toIsIp', 'fromIsIp', 'payload', 'raw'];

function p(v: string | number) {
  return ('0' + v).slice(-2);
}

class PersistentStorage {
  fd: number | null = null;
  enabled: boolean;
  nextDayTstamp: number | null;

  async enable(stream: Stream) {
    this.enabled = true;
    await this.openFD();

    stream.on('data', async (data: SocketMessage<any>) => {
      if (!this.enabled) return;
      if (data.type !== 'telegram') return;
      if (data.payload.tstamp >= this.nextDayTstamp) {
        await this.openFD();
      }
      const d = new Date(data.payload.tstamp);
      data.payload.date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${(p(d.getHours()))}:${p(d.getMinutes())}:${p(d.getSeconds())}.${('00' + d.getMilliseconds()).slice(-3)}`;
      const res = csvFields.map(fld => data.payload[fld]);
      console.log(data.payload.raw)
      this.writeLn(res.join(';'));
    });
  }

  async disable() {
    this.enabled = false;
    await this.closeFD();
  }

  getCurrentFilename() {
    const d = new Date();
    return `TelegramsXS_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.csv`;
  }

  writeLn(data: string) {
    fs.write(this.fd, data + "\n", (err) => {
      if (!err) return;
      console.error(err);
      console.error('Persistent storage stopped.');
      errors.add('pstoreWrite', `Storage write error: ${err.toString()}`);
      this.disable();
    });
  }

  async openFD() {
    if (this.fd) await this.closeFD();
    const d = new Date();
    this.nextDayTstamp = d.setHours(24, 0, 0, 0);
    const file = path.resolve(store.appPath, this.getCurrentFilename());
    console.log('Opening', file, 'for persistent storage.');
    return new Promise(async (resolve) => {
      try {
        const exists = await promisify(fs.exists)(file);
        this.fd = await promisify(fs.open)(file, 'a');
        if (!exists) {
          // Add header to new files
          this.writeLn(csvFields.join(';'));
        }
      } catch (err) {
        errors.add('pstoreOpen', `Storage open error: ${err.toString()}`);
        console.error(err);
      }
      resolve();
    });
  }

  async closeFD() {
    if (this.fd) {
      await promisify(fs.close)(this.fd);
    }
  }

  async getFiles() {
    try {
      let files = await promisify(fs.readdir)(store.appPath);
      files = files.filter(file => file.match(/^TelegramsXS_.+\.csv$/));
      files.sort();
      files.reverse();
      return await Promise.all(files.map(async f => ({
        name: f,
        size: (await promisify(fs.stat)(path.resolve(store.appPath, f))).size
      })));
    } catch (e) {
      errors.add('pstore', `Could not fetch file list: ${e.toString()}`);
      console.error(e);
      return [];
    }
  }

  async getFileContent(file: string) {
    return promisify(fs.readFile)(path.resolve(store.appPath, file), 'utf8');
  }

  async deleteFile(fileToDelete: string) {
    const file = path.resolve(store.appPath, fileToDelete);
    try {
      await promisify(fs.unlink)(file);
    } catch (err) {
      console.error(err);
      errors.add('pstoreDelExp', `Storage expired file deletion error: ${err.toString()}`);
    }
  }

  async deleteExpiredFiles() {
    const maxFiles = store.getConfig('persistentStorage').keepFiles;
    if (maxFiles === 0) return;
    (await this.getFiles())
      .slice(maxFiles)
      .forEach((file) => {
        console.log('Delete expired file', file.name);
        this.deleteFile(file.name);
      });
  }
}

const ps = new PersistentStorage();

// garbage collection every 24h
setInterval(
  () => ps.deleteExpiredFiles(),
  3600 * 24 * 1000
);

// garbage collection once 5m after start
setTimeout(
  () => ps.deleteExpiredFiles(),
  5 * 60 * 1000
);

// Singleton
export default ps;
