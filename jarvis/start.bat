@echo off
chcp 65001 > nul
REM 자비스 실행기 - 더블클릭하면 된다
cd /d "%~dp0"
python -c "import edge_tts" 2>nul || pip install edge-tts
python server.py
pause
