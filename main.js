const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const { downloadAll, downloadAllGifs } = require('./downloader.js');

let mainWindow;
let abortController = null;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    title: 'Mixamo Downloader',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadFile('app.html');

  // Allow webview to open Adobe login popups
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'allow' };
  });
});

app.on('window-all-closed', () => app.quit());

// ── IPC Handlers ────────────────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select animations folder',
    properties: ['openDirectory'],
    defaultPath: path.join(__dirname, 'Animations')
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('start-download', async (event, { token, characterId, outputDir, forceRefresh }) => {
  abortController = new AbortController();

  try {
    const stats = await downloadAll({
      bearer: token,
      characterId,
      outputDir,
      forceRefresh: !!forceRefresh,
      abortSignal: abortController.signal,
      onProgress: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-progress', data);
        }
      }
    });
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('download-gifs', async (event, { token, characterId, outputDir }) => {
  abortController = new AbortController();
  try {
    const stats = await downloadAllGifs({
      bearer: token,
      characterId,
      outputDir,
      abortSignal: abortController.signal,
      onProgress: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-progress', data);
        }
      }
    });
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stop-download', () => {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  return true;
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  const { shell } = require('electron');
  shell.openPath(folderPath);
});
