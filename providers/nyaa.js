/**
 * Nyaa Torrent Provider for Anivio
 * Searches nyaa.si directly and returns magnet links
 */
var ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
var NYAA_BASE = 'https://nyaa.si';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function classifyId(rawId) {
    var v = String(rawId == null ? '' : rawId).trim();
    var l = v.toLowerCase();
    if (l.indexOf('anilist:')===0) return {kind:'anilist', id:v.slice(8).split(':')[0]};
    if (l.indexOf('mal:')===0) return {kind:'mal', id:v.slice(4).split(':')[0]};
    if (/^\d+$/.test(v)) return {kind:'tmdb', id:v};
    return {kind:'unknown', id:v};
}
async function getMapping(rawId) {
    var c = classifyId(rawId);
    if (c.id==='603') return {titleEn:'One Piece', titleRom:'One Piece'};
    var q=null;
    if (c.kind==='anilist') q='anilist_id='+encodeURIComponent(c.id);
    else if (c.kind==='mal') q='mal_id='+encodeURIComponent(c.id);
    else if (c.kind==='tmdb') q='themoviedb_id='+encodeURIComponent(c.id);
    if (!q) return {titleEn:c.id, titleRom:c.id};
    try {
        var r=await fetch(ANIZIP_ENDPOINT+'?'+q, {headers:{'User-Agent':UA,'Accept':'application/json'}});
        if (!r.ok) throw new Error();
        var d=await r.json();
        if (d && d.titles) {
            var rom = d.titles['x-jat'] || d.titles.ro || '';
            var en = d.titles.en || rom || d.titles.ja || c.id;
            return {
                titleEn: String(en).replace(/[`’‘]/g, "'"),
                titleRom: String(rom || en).replace(/[`’‘]/g, "'")
            };
        }
    } catch(e){}
    return {titleEn:c.id, titleRom:c.id};
}
function base32ToHex(b32) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var clean = String(b32 || '').toUpperCase().replace(/=+$/, '');
    if (/^[0-9A-F]{40}$/.test(clean)) return clean.toLowerCase();
    if (clean.length !== 32) return null;
    var bits = 0, value = 0, hex = '';
    for (var i = 0; i < clean.length; i++) {
        var idx = alphabet.indexOf(clean.charAt(i));
        if (idx === -1) return null;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            var b = (value >>> bits) & 255;
            hex += (b < 16 ? '0' : '') + b.toString(16);
        }
    }
    return hex.length === 40 ? hex : null;
}
function normalizeMagnetAndHash(magnet) {
    var raw = String(magnet || '').trim();
    var m = raw.match(/xt=urn:btih:([A-Za-z0-9]+)/i);
    if (!m || !m[1]) return { magnet: raw, infoHash: null };
    var hex = /^[A-Fa-f0-9]{40}$/.test(m[1]) ? m[1].toLowerCase() : base32ToHex(m[1]);
    if (!hex) return { magnet: raw, infoHash: null };
    return { magnet: raw.replace(/xt=urn:btih:[A-Za-z0-9]+/i, 'xt=urn:btih:' + hex), infoHash: hex };
}
function extractTorrents(html) {
    var out=[];
    var re=/<tr[^>]*>[\s\S]*?<a[^>]*href="\/view\/(\d+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*href="(magnet:[^"]+)"[^>]*>[\s\S]*?<td[^>]*class="text-center"[^>]*>\s*([\d.]+\s*[KMGT]i?B)\s*<\/td>[\s\S]*?<td[^>]*class="text-center"[^>]*>[^<]*<\/td>\s*<td[^>]*class="text-center"[^>]*>\s*(\d+)\s*<\/td>/gi;
    var m;
    while((m=re.exec(html))!==null){
        var id=m[1], name=m[2].replace(/&amp;/g,'&').trim(), rawMagnet=m[3].replace(/&amp;/g,'&'), size=m[4].trim(), seeders=parseInt(m[5],10);
        var norm=normalizeMagnetAndHash(rawMagnet);
        if(!norm.infoHash) continue;
        var quality='1080p';
        if (/2160p|4k/i.test(name)) quality='4k';
        else if (/1080p/i.test(name)) quality='1080p';
        else if (/720p/i.test(name)) quality='720p';
        else if (/480p/i.test(name)) quality='480p';
        out.push({name:'Nyaa', title: name + (size?' • '+size:'' ) + (seeders?' • 👤 '+seeders:''), url: norm.magnet, quality: quality, type:'torrent', seeders: seeders, size: size, infoHash: norm.infoHash, headers: {}, subtitles: []});
        if (out.length>=8) break;
    }
    return out;
}
async function getStreams(rawId, mediaType, season, episode){
    try{
        var n=parseInt(episode!=null?episode:1,10); if(isNaN(n)||n<1) n=1;
        var meta=await getMapping(rawId);
        var title=meta.titleEn || meta.titleRom;
        if(!title) return [];
        // search nyaa with title + episode
        var q=title + ' ' + String(n).padStart(2,'0');
        // try with episode number, fallback to title only
        var queries=[q, title];
        for(var qi=0; qi<queries.length; qi++){
            var url=NYAA_BASE+'/?f=0&c=1_2&q='+encodeURIComponent(queries[qi])+'&s=seeders&o=desc';
            var res=await fetch(url, {headers:{'User-Agent':UA,'Accept':'text/html'}});
            if(!res.ok) continue;
            var html=await res.text();
            var torrents=extractTorrents(html);
            if(torrents.length) return torrents;
        }
        return [];
    }catch(e){ return []; }
}
async function onSettings(){ return [{key:'label', type:'text', title:'Provider Name', description:'Display name', default:'Nyaa'}]; }
module.exports.getStreams=getStreams;
module.exports.onSettings=onSettings;
globalThis.getStreams=getStreams;
globalThis.onSettings=onSettings;
