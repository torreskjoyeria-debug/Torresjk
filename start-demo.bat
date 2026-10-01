@echo off
title Nexus POS - Cliente 2 (Modo Demo Aislado)
echo ========================================================
echo   Iniciando Nexus POS para Cliente 2 en Puerto 4000
echo   Base de Datos: cliente2_demo_pos (Aislada de Charles Joyas)
echo ========================================================

set PORT=4000
set MONGO_URI=mongodb://charlesjoyass_db_user:57XZqt7XTrFdkaKt@ac-3th3i0i-shard-00-00.ceb3uhz.mongodb.net:27017,ac-3th3i0i-shard-00-01.ceb3uhz.mongodb.net:27017,ac-3th3i0i-shard-00-02.ceb3uhz.mongodb.net:27017/cliente2_demo_pos?ssl=true&replicaSet=atlas-xpgtcp-shard-0&authSource=admin&retryWrites=true&w=majority

echo.
echo [1/2] Levantando servidor Node en segundo plano...
start "Servidor POS - Cliente 2 (Puerto 4000)" cmd /k "set PORT=4000&& set MONGO_URI=%MONGO_URI%&& node server.js"

echo [2/2] Conectando tunel publico seguro (Tunnelmole)...
echo Comparte con tu cliente la URL https://... que aparezca a continuacion:
echo.
npx tunnelmole 4000
pause
