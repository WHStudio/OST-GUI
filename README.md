# OST-GUI

## 介绍

**Forked from [rev2ret/OpenSteamTool-GUI](https://github.com/rev2ret/OpenSteamTool-GUI)**

一款开源的图形化界面程序，Widnows系统专用。

注意，本项目不包含来自[OpenSteam001/OpenSteamTool](https://github.com/OpenSteam001/OpenSteamTool)的关键源码，仅供个人学习使用！

## 教程

### 1. 构建

```powershell
cd .\manager\
pnpm i
pnpm build
pnpm dist
```

### 2. 使用

将构建所得`manager\release\OST-GUI 1.0.0.exe`放置到任意位置，然后创建`dlls`目录，放入**上游项目提供的3个dll文件**，目录结构如下：

```tree
OST-GUI
├── OST-GUI 1.0.0.exe
└── dlls
    ├── OpenSteamTool.dll
    ├── dwmapi.dll
    └── xinput1_4.dll
```
