// ip2region v4 xdb 离线查询（纯 node，无外部依赖）
// 数据文件：ip2region_v4.xdb
const fs = require('fs');
const path = require('path');

const HeaderInfoLen = 256;
const VectorIndexCols = 256;
const VectorIndexSize = 8;
const SegmentIndexSize = 14;

const XDB_FILE = path.join(__dirname, 'ip2region_v4.xdb');

let _buf = null;
function loadBuffer() {
  if (_buf) return _buf;
  if (!fs.existsSync(XDB_FILE)) return null;
  _buf = fs.readFileSync(XDB_FILE);
  return _buf;
}

function ip2long(ip) {
  const p = String(ip).trim().split('.');
  if (p.length !== 4) return -1;
  for (let i = 0; i < 4; i++) {
    const n = parseInt(p[i], 10);
    if (isNaN(n) || n < 0 || n > 255) return -1;
  }
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function ip2region(ip) {
  const buf = loadBuffer();
  if (!buf) return '';
  const ipInt = ip2long(ip);
  if (ipInt < 0) return '';

  try {
    // header: startIndexPtr(8), endIndexPtr(12)
    const startIndexPtr = buf.readUInt32LE(8);
    const il0 = (ipInt >>> 24) & 0xff;
    const il1 = (ipInt >>> 16) & 0xff;
    const idx = il0 * VectorIndexCols * VectorIndexSize + il1 * VectorIndexSize;
    let sPtr = buf.readUInt32LE(HeaderInfoLen + idx);
    let ePtr = buf.readUInt32LE(HeaderInfoLen + idx + 4);

    let dataPtr = 0, dataLen = 0;
    let l = 0, h = Math.floor((ePtr - sPtr) / SegmentIndexSize);
    while (l <= h) {
      const m = (l + h) >> 1;
      const p = sPtr + m * SegmentIndexSize;
      const sip = buf.readUInt32LE(p);
      if (ipInt < sip) {
        h = m - 1;
      } else {
        const eip = buf.readUInt32LE(p + 4);
        if (ipInt > eip) {
          l = m + 1;
        } else {
          dataLen = buf.readUInt16LE(p + 8);
          dataPtr = buf.readUInt32LE(p + 10);
          break;
        }
      }
    }

    if (dataPtr === 0 && dataLen === 0) return '';
    // region 数据在文件头部之后，dataPtr 是相对 startIndexPtr 的偏移？实际是绝对偏移
    const region = buf.toString('utf8', dataPtr, dataPtr + dataLen);
    return region;
  } catch (e) {
    return '';
  }
}

// 提取省级+"市"级，返回如 "山东济南市"
function ipRegionName(ip) {
  const full = ip2region(ip);
  if (!full) return '';
  // ip2region v4 格式：国家|省份|城市|区县|运营商（机房/保留 IP 的省份城市可能为 "0"）
  const parts = full.split('|');
  const clean = (x) => {
    const t = String(x || '').replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔族|自治州|地区|盟/g, '').trim();
    // "0" 或空表示无省市信息（如云机房 IP），视为无定位
    return (t === '0' || t === '') ? '' : t;
  };
  const province = clean(parts[1]);
  const city = clean(parts[2]);
  const result = (province + city).trim();
  return result;
}

module.exports = { ip2region, ipRegionName, ip2long };
