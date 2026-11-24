import re
sh=open('/home/claude/vergunbuy/src/shell.html').read()
eng=open('/home/claude/vergunbuy/src/engine.js').read()
ui=open('/home/claude/vergunbuy/src/ui.js').read()
out=sh.replace('/*ENGINE*/',eng).replace('/*UI*/',ui)
open('/home/claude/vergunbuy/vergunbuy.html','w').write(out)
print(len(out))
