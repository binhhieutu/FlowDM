const os = require('node:os');
const MAX_FRAME = 1024 * 1024;
const little = os.endianness() === 'LE';
function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > MAX_FRAME) throw new Error('Frame too large');
  const prefix = Buffer.alloc(4);
  little ? prefix.writeUInt32LE(body.length) : prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
class FrameDecoder {
  constructor(onMessage) { this.onMessage=onMessage; this.buffer=Buffer.alloc(4); this.used=0; this.size=null; }
  push(chunk) {
    while (chunk.length) {
      const needed = this.buffer.length - this.used;
      const take = Math.min(needed, chunk.length);
      chunk.copy(this.buffer,this.used,0,take);this.used+=take;
      chunk = chunk.subarray(take);
      if (this.size === null && this.used === 4) {
        this.size = little ? this.buffer.readUInt32LE() : this.buffer.readUInt32BE();
        if (!this.size || this.size > MAX_FRAME) throw new Error('Frame too large or empty');
        this.buffer=Buffer.alloc(this.size);this.used=0;
      } else if (this.size !== null && this.used === this.size) {
        const value = JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(this.buffer));
        this.buffer=Buffer.alloc(4);this.used=0;this.size=null;this.onMessage(value);
      }
    }
  }
  end() { if (this.used || this.size !== null) throw new Error('Truncated frame'); }
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
function normalizePayload(payload) {
  if (!plainObject(payload) || Object.keys(payload).some(key=>!['url','filename','headers','mediaType'].includes(key))) return null;
  if(typeof payload.url!=='string' || payload.url.length>16384 || /[\u0000-\u0020\u007f]/.test(payload.url)) return null;
  try {const url=new URL(payload.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;}catch{return null;}
  const result={url:payload.url};
  if(Object.hasOwn(payload,'filename')) {
    const name=payload.filename;
    if(typeof name!=='string'||!name.length||name.length>180||/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)||['.','..'].includes(name))return null;
    result.filename=name;
  }
  if(Object.hasOwn(payload,'mediaType')) {if(!['direct','hls'].includes(payload.mediaType))return null;result.mediaType=payload.mediaType;}
  if(Object.hasOwn(payload,'headers')) {
    if(!plainObject(payload.headers)||Object.keys(payload.headers).length>8)return null;
    const pairs=Object.entries(payload.headers).map(([name,value])=>[name.toLowerCase(),value]).sort(([a],[b])=>a.localeCompare(b));
    let size=0;const headers={};
    for(const [name,value] of pairs) {
      if(!['referer','user-agent','cookie','authorization'].includes(name)||Object.hasOwn(headers,name)||typeof value!=='string'||/[^\t\x20-\x7e\x80-\xff]/.test(value))return null;
      size+=Buffer.byteLength(name)+Buffer.byteLength(value);if(size>65536)return null;
      headers[name]=value;
    }
    result.headers=headers;
  }
  return result;
}
function validRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(',') !== 'op,payload,request_id,schema') return false;
  if (value.schema !== 1 || value.op !== 'add' || typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.request_id)) return false;
  return normalizePayload(value.payload)!==null;
}
module.exports={MAX_FRAME,encodeFrame,FrameDecoder,validRequest,normalizePayload};
