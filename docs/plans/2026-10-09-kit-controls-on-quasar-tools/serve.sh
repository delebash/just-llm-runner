#!/bin/bash
# SPDX-License-Identifier: MIT
# Start the four Q3 test servers on a slice's data copies: JW base 8781 / new 8782, JV base 8783 / new 8784.
#   bash serve.sh <sliceDir>
SP=/c/Users/danel/AppData/Local/Temp/claude/E--Dev-Web-JustVioce/010ca198-6cb0-4bfe-86b8-0e9ec1770500/scratchpad
D=$1
for p in 8781 8782 8783 8784; do c=$(netstat -ano | grep "127.0.0.1:$p .*LISTENING" | awk '{print $5}' | head -1); [ -n "$c" ] && taskkill //PID $c //F > /dev/null; done
(cd /e/Dev/Web/justwrite-app && JUSTWRITE_DATA_DIR=$D/jw-data-base JUST_AI_HOME=$D/jw-data-base JUSTWRITE_UI_DIR=$SP/q3-base/justwrite-app node scripts/node24.js server/src/serve.js serve --host 127.0.0.1 --port 8781 --data-dir $D/jw-data-base > $SP/q3/srv-8781.log 2>&1 &)
(cd /e/Dev/Web/justwrite-app && JUSTWRITE_DATA_DIR=$D/jw-data-new JUST_AI_HOME=$D/jw-data-new node scripts/node24.js server/src/serve.js serve --host 127.0.0.1 --port 8782 --data-dir $D/jw-data-new > $SP/q3/srv-8782.log 2>&1 &)
(cd /e/Dev/Web/JustVioce && JUSTVOICE_DATA_DIR=$D/jv-data-base JUST_AI_HOME=$D/jv-data-base JUSTVOICE_UI_DIR=$SP/q3-base/JustVioce node scripts/node24.js server/src/serve.js serve --host 127.0.0.1 --port 8783 --data-dir $D/jv-data-base > $SP/q3/srv-8783.log 2>&1 &)
(cd /e/Dev/Web/JustVioce && JUSTVOICE_DATA_DIR=$D/jv-data-new JUST_AI_HOME=$D/jv-data-new node scripts/node24.js server/src/serve.js serve --host 127.0.0.1 --port 8784 --data-dir $D/jv-data-new > $SP/q3/srv-8784.log 2>&1 &)
for p in 8781 8782 8783 8784; do for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$p/v1/health && break; sleep 1; done; done
echo "servers up on $D"
for p in 8785 8786; do c=$(netstat -ano | grep "127.0.0.1:$p .*LISTENING" | awk '{print $5}' | head -1); [ -n "$c" ] && taskkill //PID $c //F > /dev/null; done
(cd /e/Dev/Web/just_ai_i18n_docgen && JUST_AI_I18N_DOCGEN_DATA_DIR=$D/dg-data-base JUST_AI_HOME=$D/dg-data-base JUST_AI_I18N_DOCGEN_UI_DIR=$SP/q3-base/just_ai_i18n_docgen node scripts/node24.js server/src/serve.js serve --host 127.0.0.1 --port 8785 --data-dir $D/dg-data-base --config 'E:\Dev\Web\justwrite-app\just-ai-i18n-docgen\config.json' > $SP/q3/srv-8785.log 2>&1 &)
(cd /e/Dev/Web/just_ai_i18n_docgen && JUST_AI_I18N_DOCGEN_DATA_DIR=$D/dg-data-new JUST_AI_HOME=$D/dg-data-new node scripts/node24.js server/src/serve.js serve --host 127.0.0.1 --port 8786 --data-dir $D/dg-data-new --config 'E:\Dev\Web\justwrite-app\just-ai-i18n-docgen\config.json' > $SP/q3/srv-8786.log 2>&1 &)
for p in 8785 8786; do for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$p/v1/health && break; sleep 1; done; done
echo "docgen servers up"
