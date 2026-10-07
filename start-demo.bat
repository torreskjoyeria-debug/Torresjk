@echo off
title Nexus POS - Torres Joyería (Cluster Atlas)
echo ========================================================
echo   Iniciando Nexus POS para Torres Joyería en Puerto 4000
echo   Base de Datos: torreskjoyeria_pos
echo ========================================================

set PORT=4000
set MONGO_URI=mongodb://torreskjoyeria_db_user:URoLcZKCyxXsc7x3@ac-e37s3f2-shard-00-00.i2bsl70.mongodb.net:27017,ac-e37s3f2-shard-00-01.i2bsl70.mongodb.net:27017,ac-e37s3f2-shard-00-02.i2bsl70.mongodb.net:27017/torreskjoyeria_pos?ssl=true&replicaSet=atlas-14ojy7-shard-0&authSource=admin&retryWrites=true&w=majority

echo.
echo [1/2] Levantando servidor Node en segundo plano...
start "Servidor POS - Torres Joyería (Puerto 4000)" cmd /k "set PORT=4000&& set MONGO_URI=%MONGO_URI%&& node server.js"

echo [2/2] Conectando tunel publico seguro (Tunnelmole)...
echo Comparte con tu cliente la URL https://... que aparezca a continuacion:
echo.
npx tunnelmole 4000
pause
