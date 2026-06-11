@echo off
title Mixamo Downloader
cd /d "%~dp0"
if not exist node_modules\electron (
    echo First run - installing Electron...
    npm install
)
npx electron .
