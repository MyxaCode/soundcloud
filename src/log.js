const fs = require('fs');
let p = null;
module.exports = {
  setPath(x) { p = x; try { fs.writeFileSync(p, '--- log start ' + new Date().toISOString() + ' ---\n'); } catch (e) {} },
  w(msg) { if (!p) return; try { fs.appendFileSync(p, new Date().toISOString().slice(11, 23) + ' ' + msg + '\n'); } catch (e) {} }
};
