const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');
const AdmZip = require('adm-zip');

let mainWindow;

ipcMain.on('close-app', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择 Steam 文件夹'
  });
  if (!canceled && filePaths.length > 0) {
    return filePaths[0];
  }
  return null;
});

ipcMain.handle('search-game', async (event, term) => {
  return new Promise((resolve) => {
    const safeTerm = encodeURIComponent(term);
    const url = `https://store.steampowered.com/api/storesearch/?term=${safeTerm}&l=english&cc=US`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.items && json.items.length > 0) {
            const results = json.items.map(item => ({ id: item.id.toString(), name: item.name }));
            resolve({ success: true, results });
          } else {
            resolve({ success: true, results: [] });
          }
        } catch {
          resolve({ success: false, results: [] });
        }
      });
    }).on('error', () => {
      resolve({ success: false, results: [] });
    });
  });
});

ipcMain.handle('install-online-fix', async (event, { steamPath, appId, zipPath }) => {
  try {
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdfPath)) {
      return { success: false, message: '找不到 libraryfolders.vdf。Steam 路径可能无效。' };
    }

    const vdfContent = fs.readFileSync(vdfPath, 'utf8');
    const pathRegex = /"path"\s+"([^"]+)"/g;
    let match;
    let targetInstallDir = null;

    while ((match = pathRegex.exec(vdfContent)) !== null) {
      const libraryPath = match[1].replace(/\\\\/g, '\\');
      const acfPath = path.join(libraryPath, 'steamapps', `appmanifest_${appId}.acf`);
      
      if (fs.existsSync(acfPath)) {
        const acfContent = fs.readFileSync(acfPath, 'utf8');
        const installDirMatch = acfContent.match(/"installdir"\s+"([^"]+)"/);
        if (installDirMatch) {
          targetInstallDir = path.join(libraryPath, 'steamapps', 'common', installDirMatch[1]);
          break;
        }
      }
    }

    if (!targetInstallDir) {
      return { success: false, message: `找不到 AppID ${appId} 的安装。请确保已通过 Steam 下载。` };
    }
    if (!fs.existsSync(targetInstallDir)) {
      return { success: false, message: `在磁盘上未找到安装文件夹：${targetInstallDir}` };
    }

    // Extract zip directly into target install dir
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetInstallDir, true); // true = overwrite

    return { success: true, message: `已成功将修复安装到：${path.basename(targetInstallDir)}` };
  } catch (err) {
    return { success: false, message: '应用修复时出错：' + err.message };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hidden',
    backgroundColor: '#0f172a', // slate-900
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png')
  });

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// Helper to resolve Steam installation path from registry
function getSteamPath() {
  return new Promise((resolve) => {
    exec('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
      if (match && match[1]) {
        resolve(match[1].trim());
      } else {
        resolve(null);
      }
    });
  });
}

// Resolve dlls/ directory next to the executable.
// For portable (single-exe) builds, electron-builder extracts the app to a
// temp directory at runtime, so app.getPath('exe') points there.  We must
// read PORTABLE_EXECUTABLE_FILE to find where the user actually placed dlls/.
function getDllDir() {
  if (!app.isPackaged) {
    return path.join(__dirname, '../../dlls');
  }
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  return path.join(path.dirname(exePath), 'dlls');
}

// Automatically patch Steam DLLs on startup if they are missing
async function autoPatchOnStartup() {
  try {
    const steamPath = await getSteamPath();
    if (!steamPath) return;

    const dllDir = getDllDir();

    const dlls = ['OpenSteamTool.dll', 'dwmapi.dll', 'xinput1_4.dll'];

    // Check if all DLLs are already present in the Steam directory
    let allExist = true;
    for (const dll of dlls) {
      if (!fs.existsSync(path.join(steamPath, dll))) {
        allExist = false;
        break;
      }
    }

    // If already patched, do not attempt to patch again (prevents killing Steam)
    if (allExist) return;

    const copyDlls = () => {
      if (!fs.existsSync(dllDir)) return 0;
      let copied = 0;
      for (const dll of dlls) {
        const src = path.join(dllDir, dll);
        const dest = path.join(steamPath, dll);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          copied++;
        }
      }
      return copied;
    };

    try {
      copyDlls();
    } catch (e) {
      // If file copy fails (Steam is running and locking DLLs), kill Steam and copy
      exec('taskkill /F /IM steam.exe /T', () => {
        setTimeout(() => {
          try {
            copyDlls();
          } catch (err) {
            console.error('Failed to auto-patch DLLs on startup:', err);
          }
        }, 1500);
      });
    }
  } catch (err) {
    console.error('Error during auto-patch on startup:', err);
  }
}

app.whenReady().then(async () => {
  createWindow();
  
  // Perform automatic DLL patching on startup
  await autoPatchOnStartup();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers

ipcMain.handle('get-steam-path', async () => {
  return await getSteamPath();
});

ipcMain.handle('auto-patch', async (event, steamPath) => {
  return new Promise((resolve) => {
    try {
      const dllDir = getDllDir();
      console.log('[auto-patch] DLL directory:', dllDir);
      const dlls = ['OpenSteamTool.dll', 'dwmapi.dll', 'xinput1_4.dll'];
      
      const copyDlls = () => {
        if (!fs.existsSync(dllDir)) {
          resolve({ success: false, message: `未找到 dlls 文件夹（预期路径：${dllDir}）。请在该目录下放入 OpenSteamTool.dll、dwmapi.dll、xinput1_4.dll。` });
          return;
        }
        let copied = 0;
        for (const dll of dlls) {
          const src = path.join(dllDir, dll);
          const dest = path.join(steamPath, dll);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            copied++;
          }
        }
        if (copied > 0) {
          resolve({ success: true, message: `已成功使用 ${copied} 个 DLL 修补 Steam。` });
        } else {
          resolve({ success: false, message: `dlls 文件夹存在但缺少 DLL 文件（预期路径：${dllDir}）。请放入 OpenSteamTool.dll、dwmapi.dll、xinput1_4.dll。` });
        }
      };

      // Auto-kill steam before attempting to patch to avoid EBUSY locks
      event.sender.send('patch-status', '正在关闭 Steam 以解锁文件...');
      exec('taskkill /F /IM steam.exe /T', () => {
        // Wait 1.5 seconds to ensure handles are released
        setTimeout(copyDlls, 1500);
      });

    } catch (e) {
      resolve({ success: false, message: e.message });
    }
  });
});

ipcMain.handle('install-mods', async (event, { steamPath, files }) => {
  return new Promise((resolve) => {
    try {
      const luaDir = path.join(steamPath, 'config', 'lua');
      const depotDir = path.join(steamPath, 'depotcache');
      
      if (!fs.existsSync(luaDir)) fs.mkdirSync(luaDir, { recursive: true });
      if (!fs.existsSync(depotDir)) fs.mkdirSync(depotDir, { recursive: true });
      
      let installed = 0;
      for (const file of files) {
        if (!file || typeof file !== 'string') continue;
        
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
        } catch (e) {
          continue; // File doesn't exist or can't be read
        }

        const ext = path.extname(file).toLowerCase();
        const basename = path.basename(file);
        
        if (ext === '.lua') {
          fs.copyFileSync(file, path.join(luaDir, basename));
          installed++;
        } else if (ext === '.manifest') {
          fs.copyFileSync(file, path.join(depotDir, basename));
          installed++;
        }
      }
      resolve({ success: true, message: `已安装 ${installed} 个文件。` });
    } catch (e) {
      resolve({ success: false, message: e.message });
    }
  });
});

const downloadManifestForAppId = (appid, steamPath, event, isDlc = false) => {
  return new Promise((resolve) => {
    if (!isDlc) event.sender.send('download-status', `正在检查数据库中 AppID：${appid}...`);
    else event.sender.send('download-status', `正在检查数据库中 DLC：${appid}...`);
    
    const verifyUrl = `https://api.github.com/repos/SSMGAlt/ManifestHub2/branches/${appid}`;
    const options = { headers: { 'User-Agent': 'Chrome' } };
    
    https.get(verifyUrl, options, (res) => {
      if (res.statusCode !== 200) {
        if (!isDlc) resolve({ success: false, message: `在数据库中未找到 AppID ${appid} 的清单文件（状态：${res.statusCode}）。` });
        else resolve({ success: true, installed: 0 }); // Silently ignore DLCs without branches
        return;
      }
      
      if (!isDlc) event.sender.send('download-status', `已找到 ${appid} 的清单文件。正在下载...`);
      else event.sender.send('download-status', `已找到 DLC ${appid} 的清单文件。正在下载...`);
      
      const downloadUrl = `https://codeload.github.com/SSMGAlt/ManifestHub2/zip/refs/heads/${appid}`;
      const tempZipPath = path.join(__dirname, `../../temp_${appid}.zip`);
      const fileStream = fs.createWriteStream(tempZipPath);
      
      https.get(downloadUrl, options, (downloadRes) => {
        downloadRes.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          if (!isDlc) event.sender.send('download-status', `${appid} 下载完成。正在解压...`);
          else event.sender.send('download-status', `DLC ${appid} 下载完成。正在解压...`);
          
          try {
            const zip = new AdmZip(tempZipPath);
            const zipEntries = zip.getEntries();
            const luaDir = path.join(steamPath, 'config', 'lua');
            const depotDir = path.join(steamPath, 'depotcache');
            if (!fs.existsSync(luaDir)) fs.mkdirSync(luaDir, { recursive: true });
            if (!fs.existsSync(depotDir)) fs.mkdirSync(depotDir, { recursive: true });
            
            let installed = 0;
            for (const entry of zipEntries) {
              if (entry.isDirectory) continue;
              const ext = path.extname(entry.name).toLowerCase();
              if (ext === '.lua') {
                fs.writeFileSync(path.join(luaDir, entry.name), entry.getData());
                installed++;
              } else if (ext === '.manifest') {
                fs.writeFileSync(path.join(depotDir, entry.name), entry.getData());
                installed++;
              }
            }
            fs.unlinkSync(tempZipPath);
            
            if (installed > 0) resolve({ success: true, installed, message: `已成功获取并安装 ${appid} 的文件！` });
            else {
              if (isDlc) resolve({ success: true, installed: 0 });
              else resolve({ success: false, message: '已下载压缩包但其中未找到 .lua 或 .manifest 文件。' });
            }
          } catch (err) {
            if (isDlc) resolve({ success: true, installed: 0 });
            else resolve({ success: false, message: '解压 zip 时出错：' + err.message });
          }
        });
      }).on('error', (err) => {
        if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
        if (isDlc) resolve({ success: true, installed: 0 });
        else resolve({ success: false, message: '下载失败：' + err.message });
      });
    }).on('error', (err) => {
      if (isDlc) resolve({ success: true, installed: 0 });
      else resolve({ success: false, message: 'API 请求失败：' + err.message });
    });
  });
};

ipcMain.handle('download-manifests', async (event, { steamPath, appid, dlcs }) => {
  const baseResult = await downloadManifestForAppId(appid, steamPath, event, false);
  
  if (!baseResult.success) {
    return baseResult;
  }
  
  let totalInstalled = baseResult.installed || 0;
  
  if (dlcs && dlcs.length > 0) {
    for (const dlcAppId of dlcs) {
      const dlcResult = await downloadManifestForAppId(dlcAppId, steamPath, event, true);
      totalInstalled += (dlcResult.installed || 0);
    }
  }
  
  return { success: true, message: `已成功获取并安装 ${appid}${dlcs && dlcs.length > 0 ? ' 及其 DLC' : ''} 的 ${totalInstalled} 个文件！` };
});

ipcMain.handle('restart-steam', async (event, steamPath) => {
  return new Promise((resolve) => {
    exec('taskkill /F /IM steam.exe', (error) => {
      const steamExe = path.join(steamPath, 'steam.exe');
      try {
        const { spawn } = require('child_process');
        const child = spawn(steamExe, [], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        resolve({ success: true, message: 'Steam 正在重启...' });
      } catch (startError) {
        resolve({ success: false, message: startError.message });
      }
    });
  });
});

ipcMain.handle('list-installed', async (event, steamPath) => {
  try {
    const luaDir = path.join(steamPath, 'config', 'lua');
    const depotDir = path.join(steamPath, 'depotcache');

    if (!fs.existsSync(luaDir)) return [];

    const luaFiles = fs.readdirSync(luaDir).filter(f => f.endsWith('.lua'));
    const games = [];

    for (const file of luaFiles) {
      const content = fs.readFileSync(path.join(luaDir, file), 'utf-8');
      
      // Try to extract AppID from the lua content or filename
      let appId = null;
      let gameName = file.replace('.lua', '');
      const depotIds = [];

      // Common pattern: addappid(XXXX, ...) or appid = XXXX
      const appIdMatch = content.match(/addappid\s*\(\s*(\d+)/i) 
        || content.match(/appid\s*=\s*(\d+)/i)
        || content.match(/app_?id\s*[:=]\s*(\d+)/i)
        || file.match(/^(\d+)\.lua$/);
      
      if (appIdMatch) {
        appId = appIdMatch[1];
      }

      // Extract depot IDs from lua content
      const depotMatches = content.matchAll(/adddepot\s*\(\s*(\d+)/gi);
      for (const m of depotMatches) {
        depotIds.push(m[1]);
      }

      // Count associated manifest files
      let manifestCount = 0;
      if (fs.existsSync(depotDir)) {
        const manifests = fs.readdirSync(depotDir);
        for (const depotId of depotIds) {
          const found = manifests.filter(m => m.startsWith(depotId + '_'));
          manifestCount += found.length;
        }
      }

      games.push({
        luaFile: file,
        appId,
        gameName,
        depotIds,
        manifestCount,
        fileSize: fs.statSync(path.join(luaDir, file)).size,
      });
    }

    return games;
  } catch (e) {
    return [];
  }
});

ipcMain.handle('list-steam-apps', async (event, steamPath) => {
  try {
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdfPath)) return [];

    const vdfContent = fs.readFileSync(vdfPath, 'utf8');
    const pathRegex = /"path"\s+"([^"]+)"/g;
    let match;
    const apps = [];

    while ((match = pathRegex.exec(vdfContent)) !== null) {
      const libraryPath = match[1].replace(/\\\\/g, '\\');
      const steamappsPath = path.join(libraryPath, 'steamapps');
      if (fs.existsSync(steamappsPath)) {
        const files = fs.readdirSync(steamappsPath);
        for (const file of files) {
          if (file.startsWith('appmanifest_') && file.endsWith('.acf')) {
            const acfPath = path.join(steamappsPath, file);
            const acfContent = fs.readFileSync(acfPath, 'utf8');
            const appIdMatch = acfContent.match(/"appid"\s+"([^"]+)"/);
            const nameMatch = acfContent.match(/"name"\s+"([^"]+)"/);
            if (appIdMatch && nameMatch) {
              apps.push({
                appId: appIdMatch[1],
                name: nameMatch[1]
              });
            }
          }
        }
      }
    }
    
    // Sort apps alphabetically
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return apps;
  } catch (err) {
    return [];
  }
});

ipcMain.handle('remove-game', async (event, { steamPath, luaFile, depotIds }) => {
  try {
    const luaDir = path.join(steamPath, 'config', 'lua');
    const depotDir = path.join(steamPath, 'depotcache');
    let removed = 0;

    // Remove the lua script
    const luaPath = path.join(luaDir, luaFile);
    if (fs.existsSync(luaPath)) {
      fs.unlinkSync(luaPath);
      removed++;
    }

    // Remove associated manifests
    if (fs.existsSync(depotDir) && depotIds && depotIds.length > 0) {
      const manifests = fs.readdirSync(depotDir);
      for (const depotId of depotIds) {
        for (const manifest of manifests) {
          if (manifest.startsWith(depotId + '_') && manifest.endsWith('.manifest')) {
            fs.unlinkSync(path.join(depotDir, manifest));
            removed++;
          }
        }
      }
    }

    return { success: true, message: `已移除 ${removed} 个文件。` };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

ipcMain.handle('lookup-appid', async (event, appid) => {
  return new Promise((resolve) => {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json[appid] && json[appid].success) {
            resolve({ 
              success: true, 
              name: json[appid].data.name,
              dlcs: json[appid].data.dlc ? json[appid].data.dlc.map(String) : []
            });
          } else {
            resolve({ success: false, name: null, dlcs: [] });
          }
        } catch {
          resolve({ success: false, name: null, dlcs: [] });
        }
      });
    }).on('error', () => {
      resolve({ success: false, name: null, dlcs: [] });
    });
  });
});
