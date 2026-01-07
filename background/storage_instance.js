// background/storage_instance.js
import { StorageManager } from '../utils/storageManager.js';
import { broadcastLog } from './messaging.js';

export const storage = new StorageManager('mpv_organizer_data', broadcastLog);
