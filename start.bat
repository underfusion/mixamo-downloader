@echo off
title Mixamo Downloader
cd /d "%~dp0"
if not exist node_modules\electron (
    echo Pierwsza instalacja - instalowanie Electron...
    npm install
)
npx electron .
