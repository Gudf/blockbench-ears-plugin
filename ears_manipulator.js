(function () {

const FORMAT_ID = "ears_skin";

var format, panel;
var eventListeners = [];

class BigIntBitStream {
    constructor() {
        this.bi = 0n;
        this.len = 0n;
    }

    write(bits, val) {
        let bi_bits = BigInt(bits);
        this.bi = (this.bi << bi_bits) | (BigInt(val) & ((1n << (bi_bits)) - 1n));
        this.len += bi_bits;
    }

    writeBool(val) {
        this.write(1, val);
    }

    writeSAMUnit(bits, val) {
        this.writeBool(val < 0);
        let max = (1 << bits) - 1;
        this.write(bits, Math.round(Math.abs(val * max)));
    }

    writeUnit(bits, val) {
        let max = (1 << bits) - 1;
        this.write(bits, Math.ceil(val * max));
    }

    read(bits) {
        if (bits <= this.len) {
            let bi_bits = BigInt(bits);
            this.len -= bi_bits;
            let val = (this.bi >> this.len) & ((1n << bi_bits) - 1n);
            // this.bi = this.bi & ((1n << this.len) - 1n);
            return Number(val);
        } else { // not enought bits remaining, fill with 0
            this.write(bits, 0);
            return this.read(bits);
        }
    }

    readBool() {
        return this.read(1) == 1;
    }

    readSAMUnit(bits) {
        let neg = this.readBool();
        let val = this.read(bits);
        let max = (1 << bits) - 1;
        let f = val / max;
        return neg ? -f : f;
    }

    readUnit(bits) {
        let val = this.read(bits);
        let max = (1 << bits) - 1;
        return val/max;
    }

    readEnd(bits) {
        let bi_bits = BigInt(bits);
        let val = this.bi & ((1n << bi_bits) - 1n)
        this.len = this.len - bi_bits;
        this.bi = this.bi >> bi_bits;
        return Number(val);
    }
}

const alfalfa_max_bytes = 1372; // 7 bits of the alpha channel per pixel
const alfalfa_predef_keys = ["END", "wing", "erase", "cape"];
const alfalfa_MAGIC = 0xEA1FA1FA; // EALFALFA

const alfalfa_rectangles = [
    [8, 0, 16, 8],
    [0, 8, 8, 8],
    [16, 8, 16, 8],
    [4, 16, 8, 4],
    [20, 16, 16, 4],
    [44, 16, 8, 4],
    [0, 20, 56, 12],
    [20, 48, 8, 4],
    [36, 48, 8, 4],
    [16, 52, 32, 12]
]

function extractDataFromDataUrl(data_url) {
    return data_url.split(',')[1];
}

function b64ToBytes(b64) {
    return Uint8Array.from(atob(b64), b => b.charCodeAt(0));
}

function b64ToDataUrl(b64, format = "application/octet-stream") {
    return `data:${format};base64,${b64}`;
}

function bytesToB64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

// function dataUrlToBytes(data_url) {
//     let data = extractDataFromDataUrl(data_url);
//     if (data_url.split(',')[0].endsWith(";base64")) {
//         data = atob(data);
//     }
//     return Uint8Array.from(data, b => b.charCodeAt(0));
// }

// async function blobToDataURL(blob) {
//     var data_url;
//     const p = new Promise(resolve => {
//         var reader = new FileReader();
//         reader.onloadend = function() {
//             data_url = reader.result;
//             resolve();
//         };
//         reader.readAsDataURL(blob);
//     });
//     await p;
//     return data_url;
// }

function loadAlfalfaFromCanvasCtx(ctx) {
    let alfalfa = {entries: {}};
    var bi = 0n;
    var read = 0n;
    for (const [minx, miny, dx, dy] of alfalfa_rectangles) {
        const image_data = ctx.getImageData(minx, miny, dx, dy);
        var data = image_data.data;
        for (var x = 0; x < dx; x++) {
            for (var y = 0; y < dy; y++) {
                var v = data[4 * (x + y * dx) + 3];
                data[4 * (x + y * dx) + 3] = 255;
                if (v > 0){
                    v = 0x7F - (v & 0x7F);
                    bi = bi | (BigInt(v) << read * 7n);
                    read++;
                }
            }
        }
        ctx.putImageData(image_data, minx, miny);
    }
    var data_bytes = [];
    while (bi > 0) {
        data_bytes.push(Number(bi & 0b11111111n));
        bi = bi >> 8n;
    }
    data_bytes.reverse();

    var data_iter = data_bytes.values();
    let magic = (
        (data_iter.next().value * (1 << 24))
        + (data_iter.next().value * (1 << 16))
        + (data_iter.next().value * (1 << 8))
        + (data_iter.next().value)
    )

    if (magic != alfalfa_MAGIC) {
        // Not Alfalfa data
        return alfalfa;
    }

    const ver = data_iter.next().value;
    alfalfa.version = ver;
    alfalfa.raw = data_bytes;

    // only know how to parse version 1
    if (ver != 1) {
        return alfalfa;
    }

    parse_entries: while(true) {
        var index = data_iter.next().value;
        var k;
        if (index < 64) {
            // predefined keys
            if (index < alfalfa_predef_keys.length) {
                k = alfalfa_predef_keys[index];
            } else {
                k = `!unk${index}`;
            }
        } else {
            // custom keys (strings)
            let cp = [index];
            parse_name: while (true){
                let val = data_iter.next().value;
                if ((val & 0x80) == 0) {
                    cp.push(val);
                } else {
                    cp.push(val & 0x7F);
                    break parse_name;
                }
            }
            k = String.fromCodePoint(...cp);
        }
        if (k == "END") break parse_entries;

        let entry_data = [];
        read_entry_data: while(true) {
            let len = data_iter.next().value;
            for (let j = 0; j < len; j++) {
                entry_data.push(data_iter.next().value);
            }
            if (len < 255) break read_entry_data;
        }
        if (k == "wing" || k == "cape") {
            alfalfa.entries[k] = bytesToB64(Uint8Array.from(entry_data), "image/png");
        } else {
            alfalfa.entries[k] = bytesToB64(Uint8Array.from(entry_data));
        }
    }
    return alfalfa;
}

function writeAlfalfaToCanvasCtx(alfalfa, ctx) {
    let output_stream = new BigIntBitStream();
    output_stream.write(32, alfalfa_MAGIC);
    output_stream.write(8, 1); // version

    write_entries: for (const [key, val] of Object.entries(alfalfa.entries)) {
        // entry key
        if (key == "cape" && !Project?.ears_settings?.cape) continue write_entries;
        if (key == "wing" && Project?.ears_settings?.wings_mode == "none") continue write_entries;
        let i = alfalfa_predef_keys.indexOf(key);
        if (i >= 0) {
            output_stream.write(8, i)
        } else if (key.startsWith("!unk")) {
            output_stream.write(8, parseInt(key.slice(4)));
        } else {
            for (let j = 0; j < key.length-1; j++) {
                output_stream.write(8, key.charCodeAt(j));
            }
            output_stream.write(8, 0x80 | key.charCodeAt(key.length - 1));
        }

        //entry data
        let bytes = b64ToBytes(val);

        let remaining = bytes.length;
        let j = 0;
        while (remaining > 0) {
            let chunk_size = Math.min(255, remaining);
            output_stream.write(8, chunk_size);
            for (let counter = 0; counter < chunk_size; counter++) {
                output_stream.write(8, bytes[j]);
                j++;
                remaining--;
            }
        }

        if (bytes.length % 255 == 0) output_stream.write(8, 0);
    }
    output_stream.write(8, 0); // end tag
    if (output_stream.len > alfalfa_max_bytes * 8) return false;


    write_data: for (const [minx, miny, dx, dy] of alfalfa_rectangles) {
        const image_data = ctx.getImageData(minx, miny, dx, dy);
        var data = image_data.data;
        for (var x = 0; x < dx; x++) {
            for (var y = 0; y < dy; y++) {
                var v = output_stream.readEnd(7);
                data[4 * (x + y * dx) + 3] = 0x80 | (0x7F - v);
            }
        }
        ctx.putImageData(image_data, minx, miny);
    }

    return true;
}

const ears_v0_pixel_values = new Map();
ears_v0_pixel_values.set(0x3F23D8, "blue");
ears_v0_pixel_values.set(0x23D848, "green");
ears_v0_pixel_values.set(0xD82350, "red");
ears_v0_pixel_values.set(0xB923D8, "purple");
ears_v0_pixel_values.set(0x23D8C6, "cyan");
ears_v0_pixel_values.set(0xD87823, "orange");
ears_v0_pixel_values.set(0xD823B7, "pink");
ears_v0_pixel_values.set(0xD823FF, "purple2");
ears_v0_pixel_values.set(0xFEFDF2, "white");
ears_v0_pixel_values.set(0x5E605A, "gray");

const ears_modes = [
    "none",
    "above",
    "sides",
    "behind",
    "around",
    "floppy",
    "cross",
    "out",
    "tall",
    "tall_cross"
]

const ears_anchors = [
    "center",
    "front",
    "back"
]

const protrusions_modes = [
    "none",
    "horn",
    "claws",
    "both"
]

const tail_modes = [
    "none",
    "down",
    "back",
    "up",
    "vertical"
]

const wing_modes = [
    "none",
    "symmetric_dual",
    "symmetric_single",
    "asymmetric_single_l",
    "asymmetric_single_r"
]

const ears_mode_from_color = {
    blue: "above",
    green: "sides",
    purple: "behind",
    cyan: "around",
    orange: "floppy",
    pink: "cross",
    purple2: "out",
    white: "tall",
    gray: "tall_cross"
};

const ears_anchor_from_color = {
    green: "front",
    red: "back"
};

const protrusions_from_color = {
    green: "claws",
    purple: "horn",
    cyan: "both"
};

const tail_mode_from_color = {
    blue: "down",
    green: "back",
    purple: "up",
    orange: "vertical"
}

const wings_mode_from_color = {
    pink: "symmetric_dual",
    green: "symmetric_single",
    cyan: "asymmetric_single_l",
    orange: "asymmetric_single_r"
}

function pixelValToUnit(val) {
    if (val == 0) return 0;
    var j = val - 128;
    if (j < 0) j -= 1;
    if (j >= 0) j += 1;
    return j/128;
};

function unitToPixelVal(bits, u) {
    var max = (1 << bits) - 1;
    return Math.ceil(u * max);
}

function abgrToRgb(val) {
    return ((val & 0x0000ff) << 16) | ((val & 0x00ff00) << 0) | ((val & 0xff0000) >>> 16);
};

function parseEarsSettings_V0(data) {
    const asAbgrU32 = new Uint32Array(data.buffer);
    Project.ears_settings.ears_mode = ears_mode_from_color[ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[1]))] || "none";
    if(Project.ears_settings.ears_mode == "none") {
        Project.ears_settings.ears_anchor = "center";
    } else if (Project.ears_settings.ears_mode == "behind") {
        Project.ears_settings.ears_mode = "out";
        Project.ears_settings.ears_anchor = "back";
    } else {
        Project.ears_settings.ears_anchor = ears_anchor_from_color[ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[2]))] || "center";
    };
    Project.ears_settings.protrusions = protrusions_from_color[ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[3]))] || "none";
    Project.ears_settings.tail_mode = tail_mode_from_color[ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[4]))] || "none";
    let segments = 1
    if (ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[5])) != "blue") { // blue is special-cased to all 0s
        Project.ears_settings.tail_bend_1 = Math.round(pixelValToUnit(255 - data[23]) * 90);
        Project.ears_settings.tail_bend_2 = Math.round(pixelValToUnit(data[20]) * 90);
        Project.ears_settings.tail_bend_3 = Math.round(pixelValToUnit(data[21]) * 90);
        Project.ears_settings.tail_bend_4 = Math.round(pixelValToUnit(data[22]) * 90);
        segments += Project.ears_settings.tail_bend_2 != 0 ? 1 : 0;
        segments += Project.ears_settings.tail_bend_3 != 0 ? 1 : 0;
        segments += Project.ears_settings.tail_bend_4 != 0 ? 1 : 0;
        Project.ears_settings.tail_segments = segments;
    }

    if (ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[6])) != "blue") { // special-cased to all 0s
        Project.ears_settings.snout_width = w = Math.min(7, data[24]);
        Project.ears_settings.snout_height = h = Math.min(4, data[25]);
        Project.ears_settings.snout_length = l = Math.min(8, data[26]);
        Project.ears_settings.snout_offset = Math.min(8 - Project.ears_settings.snout_height, data[29]);
        Project.ears_settings.snout = (w > 0) && (h > 0) && (l > 0);
    }

    Project.ears_settings.snout_width = Math.max(1, Project.ears_settings.snout_width);
    Project.ears_settings.snout_height = Math.max(1, Project.ears_settings.snout_height);
    Project.ears_settings.snout_length = Math.max(1, Project.ears_settings.snout_length);

    if (ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[7])) != "blue") { // special-cased to all 0s
        Project.ears_settings.chest_size = Math.round(Math.min(1, data[28] / 128) * 100);
        if (Project.ears_settings.chest_size > 0) {
            Project.ears_settings.chest = true;
        };

        Project.ears_settings.cape = (data[30] & 16) != 0;
    };

    Project.ears_settings.wings_mode = wings_mode_from_color[ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[8]))] || "none";
    Project.ears_settings.wings_animation = (ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[9])) != "red") ? "normal" : "none";
    Project.ears_settings.emissive = ears_v0_pixel_values.get(abgrToRgb(asAbgrU32[10])) == "red";
};

function parseEarsSettings_V1(data) {
    let bis = new BigIntBitStream();
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            if ((x == 0) && (y == 0)) continue;
            bis.write(8, data[4 * (x + 4 * y)]);
            bis.write(8, data[4 * (x + 4 * y) + 1]);
            bis.write(8, data[4 * (x + 4 * y) + 2]);
        }
    }

    let version = bis.read(8); // currently unused

    let ears = bis.read(6);

    if (ears == 0) {
        Project.ears_settings.ears_mode = "none";
        Project.ears_settings.ears_anchor = "center";
    } else {
        Project.ears_settings.ears_mode = ears_modes[Math.floor((ears - 1) / 3) + 1] || "none";
        Project.ears_settings.ears_anchor = ears_anchors[(ears - 1) % 3] || "center";
    }

    Project.ears_settings.protrusions = protrusions_modes[bis.read(2)] || "none";

    Project.ears_settings.tail_mode = tail_modes[bis.read(3)] || "none";

    if (Project.ears_settings.tail_mode != "none") {
        let tail_segments = bis.read(2) + 1
        Project.ears_settings.tail_segments = tail_segments;
        Project.ears_settings.tail_bend_1 = Math.round(bis.readSAMUnit(6) * 90);
        Project.ears_settings.tail_bend_2 = (tail_segments > 1) ? Math.round(bis.readSAMUnit(6) * 90) : 0;
        Project.ears_settings.tail_bend_3 = (tail_segments > 2) ? Math.round(bis.readSAMUnit(6) * 90) : 0;
        Project.ears_settings.tail_bend_4 = (tail_segments > 3) ? Math.round(bis.readSAMUnit(6) * 90) : 0;
    }

    Project.ears_settings.snout_width = bis.read(3);

    if (Project.ears_settings.snout_width > 0) {
        Project.ears_settings.snout = true;
        Project.ears_settings.snout_height = bis.read(2) + 1;
        Project.ears_settings.snout_length = bis.read(3) + 1;
        Project.ears_settings.snout_offset = Math.min(bis.read(3), 8 - Project.ears_settings.snout_height)
    }

    Project.ears_settings.chest_size = Math.round(bis.readUnit(5) * 100);
    Project.ears_settings.chest = (Project.ears_settings.chest_size > 0);

    Project.ears_settings.wings_mode = wing_modes[bis.read(3)] || "none";
    if (Project.ears_settings.wings_mode != "none") Project.ears_settings.wings_animation = bis.readBool() ? "normal" : "none";

    Project.ears_settings.cape = bis.readBool();
    Project.ears_settings.emissive = bis.readBool();
};

function parseEarsSettings(data) {
    if (data[0] == 0x3F && data[1] == 0x23 && data[2] == 0xD8) {
        parseEarsSettings_V0(data);
    } else if (data[0] == 0xEA && data[1] == 0x25 && data[2] == 0x01) {
        parseEarsSettings_V1(data);
    } else {
        return;
    }
}

function writeEarsSettings(data) {
    const settings = Project.ears_settings;

    let bos = new BigIntBitStream();

    // Magic number
    bos.write(8, 0xEA);
    bos.write(8, 0x25);
    bos.write(8, 0x01);

    // version
    bos.write(8, 0x00);

    let ears_mode_index = ears_modes.indexOf(settings.ears_mode);

    let ears = 0

    if (ears_mode_index > 0) {
        ears = (ears_mode_index - 1) * 3 + ears_anchors.indexOf(settings.ears_anchor) + 1
    }

    bos.write(6, ears);

    bos.write(2, protrusions_modes.indexOf(settings.protrusions));

    let tail_mode_index = tail_modes.indexOf(settings.tail_mode)

    bos.write(3, Math.max(0, tail_mode_index));
    if (tail_mode_index > 0) {
        bos.write(2, settings.tail_segments - 1);
        bos.writeSAMUnit(6, settings.tail_bend_1 / 90);
        if (settings.tail_segments > 1) bos.writeSAMUnit(6, settings.tail_bend_2 / 90);
        if (settings.tail_segments > 2) bos.writeSAMUnit(6, settings.tail_bend_3 / 90);
        if (settings.tail_segments > 3) bos.writeSAMUnit(6, settings.tail_bend_4 / 90);
    }

    if ((settings.snout_width > 0) && (settings.snout_height > 0) && (settings.snout_length > 0)) {
        bos.write(3, settings.snout_width);
        bos.write(2, settings.snout_height - 1);
        bos.write(3, settings.snout_length - 1);
        bos.write(3, settings.snout_offset);
    } else {
        bos.write(3, 0);
    }

    bos.writeUnit(5, settings.chest_size / 100);

    let wing_mode_index = Math.max(0, wing_modes.indexOf(settings.wings_mode));
    bos.write(3, wing_mode_index);
    if (wing_mode_index > 0) {
        bos.writeBool(settings.wings_animation == "normal");
    }

    bos.writeBool(settings.cape);
    bos.writeBool(settings.emissive);

    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            data[4 * (x + 4 * y)] = bos.read(8);
            data[4 * (x + 4 * y) + 1] = bos.read(8);
            data[4 * (x + 4 * y) + 2] = bos.read(8);
            data[4 * (x + 4 * y) + 3] = 0xFF;
        }
    }
}

function writeEarsSettingsToTexture(tex) {
    if (Project.ears_settings.enabled) {
        const image_data = tex.ctx.getImageData(0, 32, 4, 4);
        writeEarsSettings(image_data.data);
        tex.ctx.putImageData(image_data, 0, 32);
    } else {
        tex.ctx.clearRect(0, 32, 4, 4);
    }
    return tex;
}

// sample textures from the Ears Manipulator (https://ears.unascribed.com/manipulator/)
const default_texture_wide = `iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAPFBMVEUAAADk1wAAzmDMAAAAL7xVAMcAAAD////s6Kfb29un7MfLyI7sp6enuOzEp+yOy6vLjo6OnsuojssAAABfqUXPAAAAB3RSTlMAcnJycnJypd0qcAAAAh5JREFUeNrtke2O6jAMBZ1+cIAAaXre/11v41rB19uKv2i1I43cVnhQWhHjFpDAJSCRG5SbzZ8BGzZ/ZYCgLpLHAQh0EfgQsHkeEJwEyFvDxs8AcGnYeAduH7h8oL+8sxleXpxfFeCHAM4CpH0+HE778Lp/NKUvMAQs3BcQAoAFbjt9kv9NXHb6BNy0k6yGGDUgxmJIhC+u5KsH+ORzo1LHswf44EI+jgPNGNAZAk2JkFzJdXX3tWGjuucLGY6wBuoJS+AdeL1Wb30+62aj+uvl8Vicf4EvDDAEeBLgUYDc9l/dSlbaElULkNv+w3QBXaQFyFWX6AKkXusiLUC6wLquKrlba91USKoNLsuikqp4ZkOMKSDGaEgEghmQ2d1rBxCd7vkIyHGgGQM6Q6ApEQAzMM/ufmrYmNzzEQhHmAPTCWPgHWgN5yRif6mzX48io/Mv8IUBhABOAjgKADNEuhMwwZagWgAYIWK6ALRhgT02AS4A6LUuwgKAC8zzrAK70zRtKgDUBsZxVAFVPIMhRjHEyIYYyXDHwABID/DOQt57gFdm8prd7xMgIbDpA00faPrApgsAAzC8A2QhS3H3mczvAJAAO8IQKIEcSAEZWsNZ7vfizddr9iaR5PwLfFEAIcAQYAjAB4ABIt1Cbvv3bia3/Ws3AQkiXdFFWAAYdJEWIIsu0gJk1kVYAEiCYRhUQGUpRSV3c84qqSKlpALqP5SIY+lYoubXAAAAAElFTkSuQmCC`;

const default_texture_slim = `iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAPFBMVEUAAADk1wAAzmDMAAAAL7xVAMcAAAD////s6Kfb29un7MfLyI7sp6enuOzEp+yOy6vLjo6OnsuojssAAABfqUXPAAAAB3RSTlMAcnJycnJypd0qcAAAAiJJREFUeNrtlO3OqkAMhCuCI+IrH3P/93q6pVlrZeNfc+KTTgZM+rhgoogzJiRxSUhmhDF6vwu8vP9LAUFbJI8FENgi8EHg3RYIGgJyLHi9C4BLwespGD9w+UB9ea1OLy/3Vwn4QYCWgIRi+0ftP7ztH7XUBSaBi+sCkgBwwbhTm3xpXHZqAy8thc0RZ02IsxikZPjgRj6qgH/8U1ZqKVXAO8mmQJMF2lmgcyQgN50t3K8Fr6eAByfYEmuDJRIl2+Oxxax6ZE1hjdfL/b4sOlY/wVcKmARsCHgkIHX/UbOSK32JFheQC+86JVFgi3SBymyJQUDatW6aw4pRsG2bhdyzrqvGIGkpcLEnIOmCyOCI0yfEORvyDgQDIEO4Nw8g1uFzoCnQZIF1EgiOBMCgM4T7vuD1FODgBEOib3B+IQp0YnoR/0rtcK07uqdT8hN8pQBJgIYARwJA96WmB3r4EiwuAM4QnZIogDlcsMvUEQSA+LU5rBAFwzBYgD1932sMAJYCzvYEAFwQ6RxxZkecySDFORlBAEEHSBXwxpm8VQGvJIMAAiALSqJAEwXmaP4vAOh0ngJy1nkKmE6AcIIuMSemF8jTC0WgEzPfbnPMdL1Ok45VEZR3qGP1E3yVAEnAJGASIAoA3ZeamdT9W81ETrzqaEwAnCA6GhPAHC5QmS3SBSqzTe6CAkTMYYUi6LrOAlg4z7OF3DPZE5B0wcmeAMAu+Ae6rWWlId8nYgAAAABJRU5ErkJggg==`;

let toDelete = [];

function getTexture(id) {
    var textures = Texture.all.filter((tex) => tex.id == id);
    return textures[0];
}

const model_meshes = {
    // Body
    body: {
        id: "body",
        name: "Body",
        texture: "base",
        group: "body",
        origin: [0, 12, 0],
        position: [-4, 12, -2],
        size: [8, 12, 4],
        uv: {
            north: {
                position: [20, 20],
                size: [8, 12]
            },
            south: {
                position: [32, 20],
                size: [8, 12]
            },
            up: {
                position: [20, 16],
                size: [8, 4]
            },
            down: {
                position: [28, 16],
                size: [8, 4]
            },
            east: {
                position: [16, 20],
                size: [4, 12]
            },
            west: {
                position: [28, 20],
                size: [4, 12]
            }
        }
    },
    body_outer: {
        id: "body_outer",
        name: "Body Layer",
        texture: "base",
        group: "body",
        invert_faces: true,
        origin: [0, 12, 0],
        position: [-4.25, 11.75, -2.25],
        size: [8.5, 12.5, 4.5],
        uv: {
            north: {
                position: [20, 36],
                size: [8, 12]
            },
            south: {
                position: [32, 36],
                size: [8, 12]
            },
            up: {
                position: [20, 32],
                size: [8, 4]
            },
            down: {
                position: [28, 32],
                size: [8, 4]
            },
            east: {
                position: [16, 36],
                size: [4, 12]
            },
            west: {
                position: [28, 36],
                size: [4, 12]
            }
        }
    },
    // Head
    head: {
        id: "head",
        name: "Head",
        texture: "base",
        group: "head",
        origin: [0, 24, 0],
        position: [-4, 24, -4],
        size: [8, 8, 8],
        uv: {
            north: {
                position: [8, 8],
                size: [8, 8]
            },
            south: {
                position: [24, 8],
                size: [8, 8]
            },
            up: {
                position: [8, 0],
                size: [8, 8]
            },
            down: {
                position: [16, 0],
                size: [8, 8]
            },
            east: {
                position: [0, 8],
                size: [8, 8]
            },
            west: {
                position: [16, 8],
                size: [8, 8]
            }
        }
    },
    head_outer: {
        id: "head_outer",
        name: "Head Layer",
        texture: "base",
        group: "head",
        invert_faces: true,
        origin: [0, 24, 0],
        position: [-4.5, 23.5, -4.5],
        size: [9, 9, 9],
        uv: {
            north: {
                position: [40, 8],
                size: [8, 8]
            },
            south: {
                position: [56, 8],
                size: [8, 8]
            },
            up: {
                position: [40, 0],
                size: [8, 8]
            },
            down: {
                position: [48, 0],
                size: [8, 8]
            },
            east: {
                position: [32, 8],
                size: [8, 8]
            },
            west: {
                position: [48, 8],
                size: [8, 8]
            }
        }
    },
    // Left arm
    left_arm: {
        id: "left_arm",
        name: "Left Arm",
        texture: "base",
        group: "left_arm",
        origin: [-4, 24, 0],
        position: [-8, 12, -2],
        size: [4, 12, 4],
        uv: {
            north: {
                position: [36, 52],
                size: [4, 12]
            },
            south: {
                position: [44, 52],
                size: [4, 12]
            },
            up: {
                position: [36, 48],
                size: [4, 4]
            },
            down: {
                position: [40, 48],
                size: [4, 4]
            },
            east: {
                position: [32, 52],
                size: [4, 12]
            },
            west: {
                position: [40, 52],
                size: [4, 12]
            }
        }
    },
    left_arm_outer: {
        id: "left_arm_outer",
        name: "Left Arm Layer",
        texture: "base",
        group: "left_arm",
        invert_faces: true,
        origin: [-4, 24, 0],
        position: [-8.25, 11.75, -2.25],
        size: [4.5, 12.5, 4.5],
        uv: {
            north: {
                position: [52, 52],
                size: [4, 12]
            },
            south: {
                position: [60, 52],
                size: [4, 12]
            },
            up: {
                position: [52, 48],
                size: [4, 4]
            },
            down: {
                position: [56, 48],
                size: [4, 4]
            },
            east: {
                position: [48, 52],
                size: [4, 12]
            },
            west: {
                position: [56, 52],
                size: [4, 12]
            }
        }
    },
    left_arm_claw: {
        id: "left_arm_claw",
        name: "Left Arm Claw",
        texture: "base",
        group: "left_arm",
        is_ears: true,
        origin: [-4, 12, 0],
        position: [-8, 8, -2],
        size: [0, 4, 4],
        uv: {
            east: {
                position: [44, 52],
                size: [4, -4]
            },
            west: {
                position: [48, 52],
                size: [-4, -4]
            }
        }
    },
    // Right arm
    right_arm: {
        id: "right_arm",
        name: "Right Arm",
        texture: "base",
        group: "right_arm",
        origin: [4, 24, 0],
        position: [4, 12, -2],
        size: [4, 12, 4],
        uv: {
            north: {
                position: [44, 20],
                size: [4, 12]
            },
            south: {
                position: [52, 20],
                size: [4, 12]
            },
            up: {
                position: [44, 16],
                size: [4, 4]
            },
            down: {
                position: [48, 16],
                size: [4, 4]
            },
            east: {
                position: [40, 20],
                size: [4, 12]
            },
            west: {
                position: [48, 20],
                size: [4, 12]
            }
        }
    },
    right_arm_outer: {
        id: "right_arm_outer",
        name: "Right Arm Layer",
        texture: "base",
        group: "right_arm",
        invert_faces: true,
        origin: [4, 24, 0],
        position: [3.75, 11.75, -2.25],
        size: [4.5, 12.5, 4.5],
        uv: {
            north: {
                position: [44, 36],
                size: [4, 12]
            },
            south: {
                position: [52, 36],
                size: [4, 12]
            },
            up: {
                position: [44, 32],
                size: [4, 4]
            },
            down: {
                position: [48, 32],
                size: [4, 4]
            },
            east: {
                position: [40, 36],
                size: [4, 12]
            },
            west: {
                position: [48, 36],
                size: [4, 12]
            }
        }
    },
    right_arm_claw: {
        id: "right_arm_claw",
        name: "Right Arm Claw",
        texture: "base",
        group: "right_arm",
        is_ears: true,
        origin: [8, 12, 0],
        position: [8, 8, -2],
        size: [0, 4, 4],
        uv: {
            east: {
                position: [56, 20],
                size: [-4, -4]
            },
            west: {
                position: [52, 20],
                size: [4, -4]
            }
        }
    },
    // Left arm (slim)
    left_arm_slim: {
        id: "left_arm_slim",
        name: "Left Arm",
        texture: "base",
        group: "left_arm",
        origin: [-4, 24, 0],
        position: [-7, 12, -2],
        size: [3, 12, 4],
        uv: {
            north: {
                position: [36, 52],
                size: [3, 12]
            },
            south: {
                position: [43, 52],
                size: [3, 12]
            },
            up: {
                position: [36, 48],
                size: [3, 4]
            },
            down: {
                position: [39, 48],
                size: [3, 4]
            },
            east: {
                position: [32, 52],
                size: [4, 12]
            },
            west: {
                position: [39, 52],
                size: [4, 12]
            }
        }
    },
    left_arm_slim_outer: {
        id: "left_arm_slim_outer",
        name: "Left Arm Layer",
        texture: "base",
        group: "left_arm",
        invert_faces: true,
        origin: [-4, 24, 0],
        position: [-7.25, 11.75, -2.25],
        size: [3.5, 12.5, 4.5],
        uv: {
            north: {
                position: [52, 52],
                size: [3, 12]
            },
            south: {
                position: [59, 52],
                size: [3, 12]
            },
            up: {
                position: [52, 48],
                size: [3, 4]
            },
            down: {
                position: [55, 48],
                size: [3, 4]
            },
            east: {
                position: [48, 52],
                size: [4, 12]
            },
            west: {
                position: [55, 52],
                size: [4, 12]
            }
        }
    },
    left_arm_slim_claw: {
        id: "left_arm_slim_claw",
        name: "Left Arm Claw",
        texture: "base",
        group: "left_arm",
        is_ears: true,
        origin: [-4, 12, 0],
        position: [-7, 8, -2],
        size: [0, 4, 4],
        uv: {
            east: {
                position: [44, 52],
                size: [4, -4]
            },
            west: {
                position: [48, 52],
                size: [-4, -4]
            }
        }
    },
    // Right arm (slim)
    right_arm_slim: {
        id: "right_arm_slim",
        name: "Right Arm",
        texture: "base",
        group: "right_arm",
        origin: [4, 24, 0],
        position: [4, 12, -2],
        size: [3, 12, 4],
        uv: {
            north: {
                position: [44, 20],
                size: [3, 12]
            },
            south: {
                position: [51, 20],
                size: [3, 12]
            },
            up: {
                position: [44, 16],
                size: [3, 4]
            },
            down: {
                position: [47, 16],
                size: [3, 4]
            },
            east: {
                position: [40, 20],
                size: [4, 12]
            },
            west: {
                position: [47, 20],
                size: [4, 12]
            }
        }
    },
    right_arm_slim_outer: {
        id: "right_arm_slim_outer",
        name: "Right Arm Layer",
        texture: "base",
        group: "right_arm",
        invert_faces: true,
        origin: [4, 24, 0],
        position: [3.75, 11.75, -2.25],
        size: [3.5, 12.5, 4.5],
        uv: {
            north: {
                position: [44, 36],
                size: [3, 12]
            },
            south: {
                position: [51, 36],
                size: [3, 12]
            },
            up: {
                position: [44, 32],
                size: [3, 4]
            },
            down: {
                position: [47, 32],
                size: [3, 4]
            },
            east: {
                position: [40, 36],
                size: [4, 12]
            },
            west: {
                position: [47, 36],
                size: [4, 12]
            }
        }
    },
    right_arm_slim_claw: {
        id: "right_arm_slim_claw",
        name: "Right Arm Claw",
        texture: "base",
        group: "right_arm",
        is_ears: true,
        origin: [7, 12, 0],
        position: [7, 8, -2],
        size: [0, 4, 4],
        uv: {
            east: {
                position: [56, 20],
                size: [-4, -4]
            },
            west: {
                position: [52, 20],
                size: [4, -4]
            }
        }
    },
    // Left leg
    left_leg: {
        id: "left_leg",
        name: "Left Leg",
        texture: "base",
        group: "left_leg",
        origin: [-2, 12, 0],
        position: [-4, 0, -2],
        size: [4, 12, 4],
        uv: {
            north: {
                position: [20, 52],
                size: [4, 12]
            },
            south: {
                position: [28, 52],
                size: [4, 12]
            },
            up: {
                position: [20, 48],
                size: [4, 4]
            },
            down: {
                position: [24, 48],
                size: [4, 4]
            },
            east: {
                position: [16, 52],
                size: [4, 12]
            },
            west: {
                position: [24, 52],
                size: [4, 12]
            }
        }
    },
    left_leg_outer: {
        id: "left_leg_outer",
        name: "Left Leg Layer",
        texture: "base",
        group: "left_leg",
        invert_faces: true,
        origin: [2, 24, 0],
        position: [-4.25, -0.25, -2.25],
        size: [4.5, 12.5, 4.5],
        uv: {
            north: {
                position: [4, 52],
                size: [4, 12]
            },
            south: {
                position: [12, 52],
                size: [4, 12]
            },
            up: {
                position: [4, 48],
                size: [4, 4]
            },
            down: {
                position: [8, 48],
                size: [4, 4]
            },
            east: {
                position: [0, 52],
                size: [4, 12]
            },
            west: {
                position: [8, 52],
                size: [4, 12]
            }
        }
    },
    left_leg_claw: {
        id: "left_leg_claw",
        name: "Left Leg Claw",
        texture: "base",
        group: "left_leg",
        is_ears: true,
        origin: [-2, 0, -2],
        position: [-4, 0, -6],
        size: [4, 0, 4],
        uv: {
            up: {
                position: [20, 52],
                size: [-4, -4]
            },
            down: {
                position: [20, 52],
                size: [-4, -4]
            }
        }
    },
    // Right leg
    right_leg: {
        id: "right_leg",
        name: "Right Leg",
        texture: "base",
        group: "right_leg",
        origin: [2, 12, 0],
        position: [0, 0, -2],
        size: [4, 12, 4],
        uv: {
            north: {
                position: [4, 20],
                size: [4, 12]
            },
            south: {
                position: [12, 20],
                size: [4, 12]
            },
            up: {
                position: [4, 16],
                size: [4, 4]
            },
            down: {
                position: [8, 16],
                size: [4, 4]
            },
            east: {
                position: [0, 20],
                size: [4, 12]
            },
            west: {
                position: [8, 20],
                size: [4, 12]
            }
        }
    },
    right_leg_outer: {
        id: "right_leg_outer",
        name: "Right Leg Layer",
        texture: "base",
        group: "right_leg",
        invert_faces: true,
        origin: [2, 24, 0],
        position: [-0.25, -0.25, -2.25],
        size: [4.5, 12.5, 4.5],
        uv: {
            north: {
                position: [4, 36],
                size: [4, 12]
            },
            south: {
                position: [12, 36],
                size: [4, 12]
            },
            up: {
                position: [4, 32],
                size: [4, 4]
            },
            down: {
                position: [8, 32],
                size: [4, 4]
            },
            east: {
                position: [0, 36],
                size: [4, 12]
            },
            west: {
                position: [8, 36],
                size: [4, 12]
            }
        }
    },
    right_leg_claw: {
        id: "right_leg_claw",
        name: "Right Leg Claw",
        texture: "base",
        group: "right_leg",
        is_ears: true,
        origin: [2, 0, -2],
        position: [0, 0, -6],
        size: [4, 0, 4],
        uv: {
            up: {
                position: [4, 20],
                size: [-4, -4]
            },
            down: {
                position: [4, 20],
                size: [-4, -4]
            }
        }
    },
    // Ears
    ears_above: {
        id: "ears_above",
        name: "Ears (Top)",
        texture: "base",
        group: "ears_top",
        complex: true,
        is_ears: true,
        origin: [0, 32, 0],
        position: [-8, 32, 0],
        vertices: {
            ears_above_wd: [0, 0, 0],
            ears_above_wu: [0, 8, 0],
            ears_above_eu: [16, 8, 0],
            ears_above_ed: [16, 0, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_above_eu",
                    "ears_above_ed",
                    "ears_above_wd",
                    "ears_above_wu"
                ],
                uv: {
                    ears_above_eu: [24, 0],
                    ears_above_ed: [24, 8],
                    ears_above_wd: [40, 8],
                    ears_above_wu: [40, 0]
                }
            },
            south: {
                vertices: [
                    "ears_above_wu",
                    "ears_above_wd",
                    "ears_above_ed",
                    "ears_above_eu"
                ],
                uv: {
                    ears_above_wu: [64, 28],
                    ears_above_wd: [56, 28],
                    ears_above_ed: [56, 44],
                    ears_above_eu: [64, 44]
                }
            }
        }
    },
    ears_sides_left: {
        id: "ears_sides_left",
        name: "Ears (Left)",
        texture: "base",
        group: "ears_left",
        complex: true,
        is_ears: true,
        origin: [-4, 28, 0],
        position: [-12, 24, 0],
        vertices: {
            ears_sides_left_wd: [0, 0, 0],
            ears_sides_left_wu: [0, 8, 0],
            ears_sides_left_eu: [8, 8, 0],
            ears_sides_left_ed: [8, 0, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_sides_left_eu",
                    "ears_sides_left_ed",
                    "ears_sides_left_wd",
                    "ears_sides_left_wu"
                ],
                uv: {
                    ears_sides_left_eu: [32, 0],
                    ears_sides_left_ed: [32, 8],
                    ears_sides_left_wd: [40, 8],
                    ears_sides_left_wu: [40, 0]
                }
            },
            south: {
                vertices: [
                    "ears_sides_left_wu",
                    "ears_sides_left_wd",
                    "ears_sides_left_ed",
                    "ears_sides_left_eu"
                ],
                uv: {
                    ears_sides_left_wu: [64, 36],
                    ears_sides_left_wd: [56, 36],
                    ears_sides_left_ed: [56, 44],
                    ears_sides_left_eu: [64, 44]
                }
            }
        }
    },
    ears_sides_right: {
        id: "ears_sides_right",
        name: "Ears (Right)",
        texture: "base",
        group: "ears_right",
        complex: true,
        is_ears: true,
        origin: [4, 28, 0],
        position: [4, 24, 0],
        vertices: {
            ears_sides_right_wd: [0, 0, 0],
            ears_sides_right_wu: [0, 8, 0],
            ears_sides_right_eu: [8, 8, 0],
            ears_sides_right_ed: [8, 0, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_sides_right_eu",
                    "ears_sides_right_ed",
                    "ears_sides_right_wd",
                    "ears_sides_right_wu"
                ],
                uv: {
                    ears_sides_right_eu: [24, 0],
                    ears_sides_right_ed: [24, 8],
                    ears_sides_right_wd: [32, 8],
                    ears_sides_right_wu: [32, 0]
                }
            },
            south: {
                vertices: [
                    "ears_sides_right_wu",
                    "ears_sides_right_wd",
                    "ears_sides_right_ed",
                    "ears_sides_right_eu"
                ],
                uv: {
                    ears_sides_right_wu: [64, 28],
                    ears_sides_right_wd: [56, 28],
                    ears_sides_right_ed: [56, 36],
                    ears_sides_right_eu: [64, 36]
                }
            }
        }
    },
    ears_around_left: {
        id: "ears_around_left",
        name: "Ears (Left)",
        texture: "base",
        group: "ears_left",
        complex: true,
        is_ears: true,
        origin: [-4, 32, 0],
        position: [-8, 24, 0],
        vertices: {
            ears_around_left_wd: [0, 0, 0],
            ears_around_left_wu: [0, 8, 0],
            ears_around_left_eu: [4, 8, 0],
            ears_around_left_ed: [4, 0, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_around_left_eu",
                    "ears_around_left_ed",
                    "ears_around_left_wd",
                    "ears_around_left_wu"
                ],
                uv: {
                    ears_around_left_eu: [44, 32],
                    ears_around_left_ed: [36, 32],
                    ears_around_left_wd: [36, 36],
                    ears_around_left_wu: [44, 36]
                }
            },
            south: {
                vertices: [
                    "ears_around_left_wu",
                    "ears_around_left_wd",
                    "ears_around_left_ed",
                    "ears_around_left_eu"
                ],
                uv: {
                    ears_around_left_wu: [20, 32],
                    ears_around_left_wd: [12, 32],
                    ears_around_left_ed: [12, 36],
                    ears_around_left_eu: [20, 36]
                }
            }
        }
    },
    ears_around_right: {
        id: "ears_around_right",
        name: "Ears (Right)",
        texture: "base",
        group: "ears_right",
        complex: true,
        is_ears: true,
        origin: [4, 32, 0],
        position: [4, 24, 0],
        vertices: {
            ears_around_right_wd: [0, 0, 0],
            ears_around_right_wu: [0, 8, 0],
            ears_around_right_eu: [4, 8, 0],
            ears_around_right_ed: [4, 0, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_around_right_eu",
                    "ears_around_right_ed",
                    "ears_around_right_wd",
                    "ears_around_right_wu"
                ],
                uv: {
                    ears_around_right_eu: [44, 16],
                    ears_around_right_ed: [36, 16],
                    ears_around_right_wd: [36, 20],
                    ears_around_right_wu: [44, 20]
                }
            },
            south: {
                vertices: [
                    "ears_around_right_wu",
                    "ears_around_right_wd",
                    "ears_around_right_ed",
                    "ears_around_right_eu"
                ],
                uv: {
                    ears_around_right_wu: [20, 16],
                    ears_around_right_wd: [12, 16],
                    ears_around_right_ed: [12, 20],
                    ears_around_right_eu: [20, 20]
                }
            }
        }
    },
    ears_out_left: {
        id: "ears_out_left",
        name: "Ears (Left)",
        texture: "base",
        group: "ears_left",
        complex: true,
        is_ears: true,
        origin: [-4, 32, 0],
        position: [-4, 32, -4],
        vertices: {
            ears_out_left_nd: [0, 0, 0],
            ears_out_left_nu: [0, 8, 0],
            ears_out_left_su: [0, 8, 8],
            ears_out_left_sd: [0, 0, 8],
        },
        faces: {
            west: {
                vertices: [
                    "ears_out_left_nu",
                    "ears_out_left_nd",
                    "ears_out_left_sd",
                    "ears_out_left_su",
                ],
                uv: {
                    ears_out_left_nu: [32, 0],
                    ears_out_left_nd: [32, 8],
                    ears_out_left_sd: [40, 8],
                    ears_out_left_su: [40, 0]
                }
            },
            east: {
                vertices: [
                    "ears_out_left_su",
                    "ears_out_left_sd",
                    "ears_out_left_nd",
                    "ears_out_left_nu",
                ],
                uv: {
                    ears_out_left_su: [64, 36],
                    ears_out_left_sd: [56, 36],
                    ears_out_left_nd: [56, 44],
                    ears_out_left_nu: [64, 44]
                }
            }
        }
    },
    ears_out_right: {
        id: "ears_out_right",
        name: "Ears (Right)",
        texture: "base",
        group: "ears_right",
        complex: true,
        is_ears: true,
        origin: [4, 32, 0],
        position: [4, 32, -4],
        vertices: {
            ears_out_right_nd: [0, 0, 0],
            ears_out_right_nu: [0, 8, 0],
            ears_out_right_su: [0, 8, 8],
            ears_out_right_sd: [0, 0, 8],
        },
        faces: {
            west: {
                vertices: [
                    "ears_out_right_nu",
                    "ears_out_right_nd",
                    "ears_out_right_sd",
                    "ears_out_right_su",
                ],
                uv: {
                    ears_out_right_nu: [64, 28],
                    ears_out_right_nd: [56, 28],
                    ears_out_right_sd: [56, 36],
                    ears_out_right_su: [64, 36]
                }
            },
            east: {
                vertices: [
                    "ears_out_right_su",
                    "ears_out_right_sd",
                    "ears_out_right_nd",
                    "ears_out_right_nu",
                ],
                uv: {
                    ears_out_right_su: [24, 0],
                    ears_out_right_sd: [24, 8],
                    ears_out_right_nd: [32, 8],
                    ears_out_right_nu: [32, 0]
                }
            }
        }
    },
    ears_floppy_left: {
        id: "ears_floppy_left",
        name: "Ears (Left)",
        texture: "base",
        group: "ears_left",
        complex: true,
        is_ears: true,
        origin: [-4, 31, 0],
        position: [-4, 31, -4],
        rotation: [0, 0, -30],
        vertices: {
            ears_floppy_left_nd: [0, -8, 0],
            ears_floppy_left_nu: [0, 0, 0],
            ears_floppy_left_su: [0, 0, 8],
            ears_floppy_left_sd: [0, -8, 8],
        },
        faces: {
            west: {
                vertices: [
                    "ears_floppy_left_nu",
                    "ears_floppy_left_nd",
                    "ears_floppy_left_sd",
                    "ears_floppy_left_su",
                ],
                uv: {
                    ears_floppy_left_nu: [32, 0],
                    ears_floppy_left_nd: [32, 8],
                    ears_floppy_left_sd: [40, 8],
                    ears_floppy_left_su: [40, 0]
                }
            },
            east: {
                vertices: [
                    "ears_floppy_left_su",
                    "ears_floppy_left_sd",
                    "ears_floppy_left_nd",
                    "ears_floppy_left_nu",
                ],
                uv: {
                    ears_floppy_left_su: [64, 36],
                    ears_floppy_left_sd: [56, 36],
                    ears_floppy_left_nd: [56, 44],
                    ears_floppy_left_nu: [64, 44]
                }
            }
        }
    },
    ears_floppy_right: {
        id: "ears_floppy_right",
        name: "Ears (Right)",
        texture: "base",
        group: "ears_right",
        complex: true,
        is_ears: true,
        origin: [4, 31, 0],
        position: [4, 31, -4],
        rotation: [0, 0, 30],
        vertices: {
            ears_floppy_right_nd: [0, -8, 0],
            ears_floppy_right_nu: [0, 0, 0],
            ears_floppy_right_su: [0, 0, 8],
            ears_floppy_right_sd: [0, -8, 8],
        },
        faces: {
            west: {
                vertices: [
                    "ears_floppy_right_nu",
                    "ears_floppy_right_nd",
                    "ears_floppy_right_sd",
                    "ears_floppy_right_su",
                ],
                uv: {
                    ears_floppy_right_nu: [64, 28],
                    ears_floppy_right_nd: [56, 28],
                    ears_floppy_right_sd: [56, 36],
                    ears_floppy_right_su: [64, 36]
                }
            },
            east: {
                vertices: [
                    "ears_floppy_right_su",
                    "ears_floppy_right_sd",
                    "ears_floppy_right_nd",
                    "ears_floppy_right_nu",
                ],
                uv: {
                    ears_floppy_right_su: [24, 0],
                    ears_floppy_right_sd: [24, 8],
                    ears_floppy_right_nd: [32, 8],
                    ears_floppy_right_nu: [32, 0]
                }
            }
        }
    },
    ears_cross: {
        id: "ears_cross",
        name: "Ears (Top)",
        texture: "base",
        group: "ears_top",
        complex: true,
        is_ears: true,
        origin: [0, 32, 0],
        position: [0, 32, 0],
        rotation: [0, -45, 0],
        vertices: {
            ears_cross_nd: [0, 0, -4],
            ears_cross_sd: [0, 0, 4],
            ears_cross_su: [0, 8, 4],
            ears_cross_nu: [0, 8, -4],
            ears_cross_wd: [-4, 0, 0],
            ears_cross_ed: [4, 0, 0],
            ears_cross_eu: [4, 8, 0],
            ears_cross_wu: [-4, 8, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_cross_eu",
                    "ears_cross_ed",
                    "ears_cross_wd",
                    "ears_cross_wu"
                ],
                uv: {
                    ears_cross_eu: [24, 0],
                    ears_cross_ed: [24, 8],
                    ears_cross_wd: [32, 8],
                    ears_cross_wu: [32, 0],
                }
            },
            south: {
                vertices: [
                    "ears_cross_wu",
                    "ears_cross_wd",
                    "ears_cross_ed",
                    "ears_cross_eu"
                ],
                uv: {
                    ears_cross_wu: [64, 28],
                    ears_cross_wd: [56, 28],
                    ears_cross_ed: [56, 36],
                    ears_cross_eu: [64, 36],
                }
            },
            west: {
                vertices: [
                    "ears_cross_nu",
                    "ears_cross_nd",
                    "ears_cross_sd",
                    "ears_cross_su",
                ],
                uv: {
                    ears_cross_nu: [32, 0],
                    ears_cross_nd: [32, 8],
                    ears_cross_sd: [40, 8],
                    ears_cross_su: [40, 0]
                }
            },
            east: {
                vertices: [
                    "ears_cross_su",
                    "ears_cross_sd",
                    "ears_cross_nd",
                    "ears_cross_nu",
                ],
                uv: {
                    ears_cross_su: [64, 36],
                    ears_cross_sd: [56, 36],
                    ears_cross_nd: [56, 44],
                    ears_cross_nu: [64, 44]
                }
            }
        }
    },
    ears_tall: {
        id: "ears_tall",
        name: "Ears (Top)",
        texture: "base",
        group: "ears_top",
        complex: true,
        is_ears: true,
        origin: [0, 32, 0],
        position: [-4, 32, 0],
        vertices: {
            ears_tall_wd: [0, 0, 0],
            ears_tall_wu: [0, 16, 0],
            ears_tall_eu: [8, 16, 0],
            ears_tall_ed: [8, 0, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_tall_eu",
                    "ears_tall_ed",
                    "ears_tall_wd",
                    "ears_tall_wu"
                ],
                uv: {
                    ears_tall_eu: [40, 0],
                    ears_tall_ed: [24, 0],
                    ears_tall_wd: [24, 8],
                    ears_tall_wu: [40, 8]
                }
            },
            south: {
                vertices: [
                    "ears_tall_wu",
                    "ears_tall_wd",
                    "ears_tall_ed",
                    "ears_tall_eu"
                ],
                uv: {
                    ears_tall_wu: [56, 28],
                    ears_tall_wd: [56, 44],
                    ears_tall_ed: [64, 44],
                    ears_tall_eu: [64, 28],
                }
            }
        }
    },
    ears_tall_cross: {
        id: "ears_tall_cross",
        name: "Ears (Top)",
        texture: "base",
        group: "ears_top",
        complex: true,
        is_ears: true,
        origin: [0, 32, 0],
        position: [0, 32, 0],
        rotation: [0, -45, 0],
        vertices: {
            ears_tall_cross_nd: [0, 0, -4],
            ears_tall_cross_sd: [0, 0, 4],
            ears_tall_cross_su: [0, 16, 4],
            ears_tall_cross_nu: [0, 16, -4],
            ears_tall_cross_wd: [-4, 0, 0],
            ears_tall_cross_ed: [4, 0, 0],
            ears_tall_cross_eu: [4, 16, 0],
            ears_tall_cross_wu: [-4, 16, 0]
        },
        faces: {
            north: {
                vertices: [
                    "ears_tall_cross_eu",
                    "ears_tall_cross_ed",
                    "ears_tall_cross_wd",
                    "ears_tall_cross_wu"
                ],
                uv: {
                    ears_tall_cross_eu: [40, 0],
                    ears_tall_cross_ed: [24, 0],
                    ears_tall_cross_wd: [24, 8],
                    ears_tall_cross_wu: [40, 8],
                }
            },
            south: {
                vertices: [
                    "ears_tall_cross_wu",
                    "ears_tall_cross_wd",
                    "ears_tall_cross_ed",
                    "ears_tall_cross_eu"
                ],
                uv: {
                    ears_tall_cross_wu: [56, 28],
                    ears_tall_cross_wd: [56, 44],
                    ears_tall_cross_ed: [64, 44],
                    ears_tall_cross_eu: [64, 28],
                }
            },
            west: {
                vertices: [
                    "ears_tall_cross_nu",
                    "ears_tall_cross_nd",
                    "ears_tall_cross_sd",
                    "ears_tall_cross_su",
                ],
                uv: {
                    ears_tall_cross_nu: [40, 0],
                    ears_tall_cross_nd: [24, 0],
                    ears_tall_cross_sd: [24, 8],
                    ears_tall_cross_su: [40, 8],
                }
            },
            east: {
                vertices: [
                    "ears_tall_cross_su",
                    "ears_tall_cross_sd",
                    "ears_tall_cross_nd",
                    "ears_tall_cross_nu",
                ],
                uv: {
                    ears_tall_cross_su: [56, 28],
                    ears_tall_cross_sd: [56, 44],
                    ears_tall_cross_nd: [64, 44],
                    ears_tall_cross_nu: [64, 28],
                }
            }
        }
    },
    // wings symmetric dual is wing symmetric l + wing symmetric r
    wing_asymmetric_l: {
        id: "wing_asymmetric_l",
        name: "Left Wing",
        texture: "wing",
        group: "wing_left",
        complex: true,
        is_ears: true,
        invert_faces: true,
        position: [-2, 10, 2],
        origin: [-2, 18, 2],
        rotation: [0, -30, 0],
        vertices: {
            wing_asymmetric_l_nd: [0, 0, 0],
            wing_asymmetric_l_nu: [0, 16, 0],
            wing_asymmetric_l_su: [0, 16, 20],
            wing_asymmetric_l_sd: [0, 0, 20]
        },
        faces: {
            west: {
                vertices: [
                    "wing_asymmetric_l_nu",
                    "wing_asymmetric_l_nd",
                    "wing_asymmetric_l_sd",
                    "wing_asymmetric_l_su",
                ],
                uv: {
                    wing_asymmetric_l_nu: [0, 0],
                    wing_asymmetric_l_nd: [0, 16],
                    wing_asymmetric_l_sd: [20, 16],
                    wing_asymmetric_l_su: [20, 0]
                }
            }
        }
    },
    wing_asymmetric_r: {
        id: "wing_asymmetric_r",
        name: "Right Wing",
        texture: "wing",
        group: "wing_right",
        complex: true,
        is_ears: true,
        invert_faces: true,
        position: [2, 10, 2],
        origin: [2, 18, 2],
        rotation: [0, 30, 0],
        vertices: {
            wing_asymmetric_r_nd: [0, 0, 0],
            wing_asymmetric_r_nu: [0, 16, 0],
            wing_asymmetric_r_su: [0, 16, 20],
            wing_asymmetric_r_sd: [0, 0, 20]
        },
        faces: {
            west: {
                vertices: [
                    "wing_asymmetric_r_nu",
                    "wing_asymmetric_r_nd",
                    "wing_asymmetric_r_sd",
                    "wing_asymmetric_r_su",
                ],
                uv: {
                    wing_asymmetric_r_nu: [0, 0],
                    wing_asymmetric_r_nd: [0, 16],
                    wing_asymmetric_r_sd: [20, 16],
                    wing_asymmetric_r_su: [20, 0]
                }
            }
        }
    },
    wing_symmetric_single: {
        id: "wing_symmetric_single",
        name: "Wing",
        texture: "wing",
        group: "wing_center",
        complex: true,
        is_ears: true,
        invert_faces: true,
        position: [0, 10, 2],
        origin: [0, 18, 2],
        vertices: {
            wing_symmetric_single_nd: [0, 0, 0],
            wing_symmetric_single_nu: [0, 16, 0],
            wing_symmetric_single_su: [0, 16, 20],
            wing_symmetric_single_sd: [0, 0, 20]
        },
        faces: {
            west: {
                vertices: [
                    "wing_symmetric_single_nu",
                    "wing_symmetric_single_nd",
                    "wing_symmetric_single_sd",
                    "wing_symmetric_single_su",
                ],
                uv: {
                    wing_symmetric_single_nu: [0, 0],
                    wing_symmetric_single_nd: [0, 16],
                    wing_symmetric_single_sd: [20, 16],
                    wing_symmetric_single_su: [20, 0]
                }
            }
        }
    },
    chest: {
        id: "chest",
        name: "Chest",
        texture: "base",
        group: "chest",
        is_ears: true,
        position: [-4, 18, -2],
        origin: [0, 22, -2],
        size: [8, 4, 4],
        uv: {
            north: {
                position: [20, 22],
                size: [8, 4]
            },
            down: {
                position: [56, 48],
                size: [8, -4]
            },
            west: {
                position: [64, 48],
                size: [-4, 4]
            },
            east: {
                position: [60, 48],
                size: [4, 4]
            },
        }
    },
    chest_outer: {
        id: "chest_outer",
        name: "Chest Layer",
        texture: "base",
        group: "chest",
        complex: true,
        is_ears: true,
        invert_faces: true,
        position: [-4.25, 17.75, -2.25],
        origin: [0, 22, -2],
        vertices: {
            chest_outer_nwd: [0, 0, 0],
            chest_outer_ned: [8.5, 0, 0],
            chest_outer_nwu: [0, 4.5, 0],
            chest_outer_neu: [8.5, 4.5, 0],
            chest_outer_swd: [0, 0, 4.5],
            chest_outer_sed: [8.5, 0, 4.5],
            chest_outer_swu: [0, 4.5, 4.5],
            chest_outer_seu: [8.5, 4.5, 4.5],
            // The next two are needed because the texture for this face is split in two
            chest_outer_nmd: [4.5, 0, 0], // north middle down
            chest_outer_nmu: [4.5, 4.5, 0], // north middle up
        },
        faces: {
            north_1: {
                vertices: [
                    "chest_outer_neu",
                    "chest_outer_ned",
                    "chest_outer_nmd",
                    "chest_outer_nmu"
                ],
                uv: {
                    chest_outer_neu: [0, 48],
                    chest_outer_ned: [0, 52],
                    chest_outer_nmd: [4, 52],
                    chest_outer_nmu: [4, 48]
                }
            },
            north_2: {
                vertices: [
                    "chest_outer_nmu",
                    "chest_outer_nmd",
                    "chest_outer_nwd",
                    "chest_outer_nwu"
                ],
                uv: {
                    chest_outer_nmu: [12, 48],
                    chest_outer_nmd: [12, 52],
                    chest_outer_nwd: [16, 52],
                    chest_outer_nwu: [16, 48]
                }
            },
            down: {
                vertices: [
                    "chest_outer_nwd",
                    "chest_outer_ned",
                    "chest_outer_sed",
                    "chest_outer_swd",
                ],
                uv: {
                    chest_outer_nwd: [36, 48],
                    chest_outer_ned: [28, 48],
                    chest_outer_sed: [28, 52],
                    chest_outer_swd: [36, 52]
                }
            },
            west: {
                vertices: [
                    "chest_outer_nwu",
                    "chest_outer_nwd",
                    "chest_outer_swd",
                    "chest_outer_swu"
                ],
                uv: {
                    chest_outer_nwu: [52, 48],
                    chest_outer_nwd: [52, 52],
                    chest_outer_swd: [48, 52],
                    chest_outer_swu: [48, 48]
                }
            },
            east: {
                vertices: [
                    "chest_outer_seu",
                    "chest_outer_sed",
                    "chest_outer_ned",
                    "chest_outer_neu"
                ],
                uv: {
                    chest_outer_seu: [48, 48],
                    chest_outer_sed: [48, 52],
                    chest_outer_ned: [52, 52],
                    chest_outer_neu: [52, 48]
                }
            }
        }
    },
    cape: {
        id: "cape",
        name: "Cape",
        texture: "cape",
        group: "cape",
        is_ears: true,
        origin: [0, 24, 2],
        position: [-5, 8, 2],
        size: [10, 16, 1],
        rotation: [-10, 0, 0],
        uv: {
            north: {
                position: [10, 0],
                size: [10, 16]
            },
            south: {
                position: [0, 0],
                size: [10, 16]
            },
            west: {
                position: [19, 0],
                size: [1, 16]
            },
            east: {
                position: [10, 0],
                size: [1, 16]
            },
            up: {
                position: [10, 0],
                size: [10, 1]
            },
            down: {
                position: [10, 15],
                size: [10, 1]
            }
        }
    },
    horn: {
        id: "horn",
        name: "Horn",
        texture: "base",
        group: "head",
        complex: true,
        is_ears: true,
        invert_faces: true,
        origin: [0, 32, -4],
        position: [-4, 32, -4],
        rotation: [-25, 0, 0],
        vertices: {
            horn_wd: [0, 0, 0],
            horn_wu: [0, 8, 0],
            horn_eu: [8, 8, 0],
            horn_ed: [8, 0, 0]
        },
        faces: {
            north: {
                vertices: [
                    "horn_eu",
                    "horn_ed",
                    "horn_wd",
                    "horn_wu"
                ],
                uv: {
                    horn_eu: [56, 0],
                    horn_ed: [56, 8],
                    horn_wd: [64, 8],
                    horn_wu: [64, 0]
                }
            }
        }
    },
    // Tail and snout are too complex to handle this way
};

function rotatePoint3(point, angle, axis, origin=[0, 0, 0]) {
    let vec = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
    let newvec = [0, 0, 0];
    angle = angle * Math.PI / 180;
    let c = Math.cos(angle), s = Math.sin(angle);
    if (typeof axis == "number") {
        if (axis == 0) {
            newvec[0] = vec[0];
            newvec[1] = c * vec[1] - s * vec[2];
            newvec[2] = s * vec[1] + c * vec[2];
        } else if (axis = 1) {
            newvec[0] = c * vec[0] + s * vec[2];
            newvec[1] = vec[1];
            newvec[2] = -s * vec[0] + c * vec[2];
        } else if (axis = 2) {
            newvec[0] = c * vec[0] - s * vec[1];
            newvec[1] = s * vec[0] + c * vec[1];
            newvec[2] = vec[2];
        }
    } else if (axis instanceof Array) {
        newvec[0] = (c + axis[0] * axis[0] * (1 - c)) * vec[0] + (axis[0] * axis[1] * (1 - c) - s * axis[2]) * vec[1] + (axis[0] * axis[2] * (1 - c) + s * axis[1]) * vec[2];
        newvec[1] = (axis[1] * axis[0] * (1 - c) + s * axis[2]) * vec[0] + (c + axis[1] * axis[1] * (1 - c)) * vec[1] + (axis[1] * axis[2] * (1 - c) - s * axis[0]) * vec[2];
        newvec[2] = (axis[2] * axis[0] * (1 - c) - s * axis[1]) * vec[0] + (axis[2] * axis[1] * (1 - c) + s * axis[0]) * vec[1] + (c + axis[2] * axis[2] * (1 - c)) * vec[2];
    }
    return [newvec[0] + origin[0], newvec[1] + origin[1], newvec[2] + origin[2]];
}

function createMesh(mesh_spec) {
    let uuid;
    Mesh.all.filter((m) => m.name == mesh_spec.name).forEach((m) => {uuid = m.uuid; m.remove();});
    if (mesh_spec.complex) return createComplexMesh(mesh_spec, uuid);
    return createSimpleMesh(mesh_spec, uuid);
}

function createEmptyTexture(id, width, height) {
    if (getTexture(id)) return;
    var canvas = Interface.createElement('canvas', {width, height});
    let t = new Texture({name: id, id, width, height}).fromDataURL(canvas.toDataURL()).add();
    t.uv_width = width;
    t.uv_height = height;
    canvas.remove();
    return t;
}

function createTail(selected, uuid) {
    if (!Project.ears_settings.enabled || Project.ears_settings.tail_mode == "none") return {elements: [], outliner: true};
    var origin, position, vertices = {};
    const segments = Project.ears_settings.tail_segments;
    let segment_length = (12 / segments);
    if (Project.ears_settings.tail_mode == "vertical") {
        origin = -Project.ears_settings.tail_bend_1 > 0 ? [0, 18, 2] : [0, 10, 2];
        position = [0, 10, 2];
        for (let i = segments; i > 0; i--) {
            vertices[`tail_segment_${i}_0`] = [0, 8, i * segment_length];
            vertices[`tail_segment_${i}_1`] = [0, 0, i * segment_length];
            for (let [k, v] of Object.entries(vertices)) {
                if (i > 1) {
                    vertices[k] = rotatePoint3(v, -Project.ears_settings[`tail_bend_${i}`], 1, [0, 0, (i - 1) * segment_length]);
                } else {
                    vertices[k] = rotatePoint3(v, -Project.ears_settings[`tail_bend_${i}`], 0, [0, origin[1] - 10, 0]);
                }
            }
        }
        vertices["tail_segment_0_0"] = rotatePoint3([0, 8, 0], -Project.ears_settings["tail_bend_1"], 0, [0, origin[1] - 10, 0]);
        vertices["tail_segment_0_1"] = rotatePoint3([0, 0, 0], -Project.ears_settings["tail_bend_1"], 0, [0, origin[1] - 10, 0]);
    } else {
        origin = [0, 14, 2];
        position = [0, 14, 2];
        for (let i = segments; i > 0; i--) {
            vertices[`tail_segment_${i}_0`] = [4, 0, i * segment_length];
            vertices[`tail_segment_${i}_1`] = [-4, 0, i * segment_length];
            for (let [k, v] of Object.entries(vertices)) {
                vertices[k] = rotatePoint3(v, -Project.ears_settings[`tail_bend_${i}`], 0, [0, 0, (i - 1) * segment_length]);
            }
        }
        vertices["tail_segment_0_0"] = [4, 0, 0];
        vertices["tail_segment_0_1"] = [-4, 0, 0];
        let angle = 0;
        switch (Project.ears_settings.tail_mode) {
            case "down":
                angle = 60;
                break;
            case "back":
                angle = Project.ears_settings.tail_bend_1 == 0 ? -10 : 0;
                break;
            case "up":
                angle = -40;
                break;
        }
        for (let [k, v] of Object.entries(vertices)) {
            vertices[k] = rotatePoint3(v, angle, 0);
        }
    }

    let faces = [];
    let texture = getTexture("base");

    let mesh = new Mesh({
        name: "Tail",
        origin: position,
        vertices: vertices
    });

    mesh.is_ears = true;

    mesh.transferOrigin(origin);

    for (let i = 0; i < segments; i++) {
        faces.push(new MeshFace(mesh, {
            texture,
            vertices: [
                `tail_segment_${i}_0`,
                `tail_segment_${i}_1`,
                `tail_segment_${i+1}_1`,
                `tail_segment_${i+1}_0`
            ],
            uv: {
                [`tail_segment_${i}_0`]: [64, 16 + i * segment_length],
                [`tail_segment_${i}_1`]: [56, 16 + i * segment_length],
                [`tail_segment_${i+1}_1`]: [56, 16 + (i+1) * segment_length],
                [`tail_segment_${i+1}_0`]: [64, 16 + (i+1) * segment_length]
            }
        }));
        faces.push(new MeshFace(mesh, {
            texture,
            vertices: [
                `tail_segment_${i+1}_0`,
                `tail_segment_${i+1}_1`,
                `tail_segment_${i}_1`,
                `tail_segment_${i}_0`
            ],
            uv: {
                [`tail_segment_${i+1}_0`]: [64, 16 + (i+1) * segment_length],
                [`tail_segment_${i+1}_1`]: [56, 16 + (i+1) * segment_length],
                [`tail_segment_${i}_1`]: [56, 16 + i * segment_length],
                [`tail_segment_${i}_0`]: [64, 16 + i * segment_length]
            }
        }));
    }

    mesh.resizable = false;

    let tail =  createGroup({
        id: "tail",
        name: "Tail",
        origin: origin,
        parent: "body",
        uuid: uuid
    });

    mesh.addTo(tail);
    mesh.addFaces(...faces);
    mesh.init();

    Canvas.updateView({
        elements: [mesh],
        groups: [tail]
    })

    if (selected) tail.select();

    return {elements: [mesh], outliner: true};
}

function createChest() {
    if (!Project.ears_settings.enabled || !Project.ears_settings.chest) return {elements: [], outliner: true};
    let chest = getOrCreateGroup("chest");
    let chest_mesh = createMesh(model_meshes.chest);
    let chest_mesh_outer = createMesh(model_meshes.chest_outer);
    chest.rotation = [Project.ears_settings.chest_size * 45 / 100, 0, 0];
    Canvas.updateView({
        groups: [chest]
    });
    return {elements: [chest_mesh, chest_mesh_outer], outliner: true};
}

function createEars() {
    if (!Project.ears_settings.enabled || Project.ears_settings.ears_mode == "none") return {elements: [], outliner: true};
    meshes = {};
    switch (Project.ears_settings.ears_mode) {
        case "around":
            meshes["left"] = createMesh(model_meshes.ears_around_left);
            meshes["right"] = createMesh(model_meshes.ears_around_right);
            // intentional fallthrough
        case "above":
            meshes["top"] = createMesh(model_meshes.ears_above);
            break;
        case "cross":
            meshes["top"] = createMesh(model_meshes.ears_cross);
            break;
        case "tall":
            meshes["top"] = createMesh(model_meshes.ears_tall);
            break;
        case "tall_cross":
            meshes["top"] = createMesh(model_meshes.ears_tall_cross);
            break;
        case "sides":
            meshes["left"] = createMesh(model_meshes.ears_sides_left);
            meshes["right"] = createMesh(model_meshes.ears_sides_right);
            break;
        case "floppy":
            meshes["left"] = createMesh(model_meshes.ears_floppy_left);
            meshes["right"] = createMesh(model_meshes.ears_floppy_right);
            break;
        case "out":
        case "behind":
            meshes["left"] = createMesh(model_meshes.ears_out_left);
            meshes["right"] = createMesh(model_meshes.ears_out_right);
            break;
    }

    switch (Project.ears_settings.ears_mode) {
        case "out":
            if (Project.ears_settings.ears_anchor == "front") {
                getGroup("ears_left")?.transferOrigin([-4, 28, -4])
                getGroup("ears_right")?.transferOrigin([4, 28, -4])
                meshes.left.moveVector([0, -8, -8]);
                meshes.right.moveVector([0, -8, -8]);
            } else if (Project.ears_settings.ears_anchor == "back") {
                getGroup("ears_left")?.transferOrigin([-4, 28, 4])
                getGroup("ears_right")?.transferOrigin([4, 28, 4])
                meshes.left.moveVector([0, -8, 8]);
                meshes.right.moveVector([0, -8, 8]);
            }
            break;
        case "behind":
            getGroup("ears_left")?.transferOrigin([-4, 28, 4])
            getGroup("ears_right")?.transferOrigin([4, 28, 4])
            meshes.left.moveVector([0, -8, 8]);
            meshes.right.moveVector([0, -8, 8]);
            break;
        case "floppy":
            getGroup("ears_left")?.transferOrigin([-4, 31, 0])
            getGroup("ears_right")?.transferOrigin([4, 31, 0])
            break;
        default:
            let lr_height = Project.ears_settings.ears_mode == "around" ? 32 : 28;
            if (Project.ears_settings.ears_anchor == "front") {
                for (let k in meshes) {
                    meshes[k].moveVector([0, 0, -4]);
                }
                getGroup("ears_top")?.transferOrigin([0, 32, -4]);
                getGroup("ears_left")?.transferOrigin([-4, lr_height, -4])
                getGroup("ears_right")?.transferOrigin([4, lr_height, -4])
            } else if (Project.ears_settings.ears_anchor == "back") {
                for (let k in meshes) {
                    meshes[k].moveVector([0, 0, 4]);
                }
                getGroup("ears_top")?.transferOrigin([0, 32, 4]);
                getGroup("ears_left")?.transferOrigin([-4, lr_height, 4])
                getGroup("ears_right")?.transferOrigin([4, lr_height, 4])
            }
            break;
    }

    Canvas.updateView({
        groups: [getGroup("ears_top"), getGroup("ears_left"), getGroup("ears_right")].filter(g => g),
        elements: Object.values(meshes)
    })

    return {elements: Object.values(meshes), outliner: true}
}

function createSnout(selected, uuid) {
    if (!Project.ears_settings.enabled || !Project.ears_settings.snout) return {elements: [], outliner: true};
    let w = Project.ears_settings.snout_width;
    let h = Project.ears_settings.snout_height;
    let l = Project.ears_settings.snout_length;
    let o = Project.ears_settings.snout_offset;
    let origin = [0, 24 + o + h/2, -4];

    let vertices = {
        snout_mwd: [-w/2, -h/2, -l+1],
        snout_med: [w/2, -h/2, -l+1],
        snout_mwu: [-w/2, h/2, -l+1],
        snout_meu: [w/2, h/2, -l+1],
        snout_nwd: [-w/2, -h/2, -l],
        snout_ned: [w/2, -h/2, -l],
        snout_nwu: [-w/2, h/2, -l],
        snout_neu: [w/2, h/2, -l],
    }

    let faces = {
        north: {
            vertices: [
                "snout_neu",
                "snout_ned",
                "snout_nwd",
                "snout_nwu"
            ],
            uv: {
                snout_neu: [0, 2],
                snout_ned: [0, 2 + h],
                snout_nwd: [w, 2 + h],
                snout_nwu: [w, 2],
            }
        },
        west_1: {
            vertices: [
                "snout_nwu",
                "snout_nwd",
                "snout_mwd",
                "snout_mwu",
            ],
            uv: {
                snout_nwu: [7, 0],
                snout_nwd: [7, h],
                snout_mwd: [8, h],
                snout_mwu: [8, 0],
            }
        },
        east_1: {
            vertices: [
                "snout_meu",
                "snout_med",
                "snout_ned",
                "snout_neu",
            ],
            uv: {
                snout_meu: [7, 0],
                snout_med: [7, h],
                snout_ned: [8, h],
                snout_neu: [8, 0],
            }
        },
        down_1: {
            vertices: [
                "snout_ned",
                "snout_med",
                "snout_mwd",
                "snout_nwd",
            ],
            uv: {
                snout_ned: [0, 2 + h],
                snout_med: [0, 3 + h],
                snout_mwd: [w, 3 + h],
                snout_nwd: [w, 2 + h],
            }
        },
        up_1: {
            vertices: [
                "snout_nwu",
                "snout_mwu",
                "snout_meu",
                "snout_neu",
            ],
            uv: {
                snout_nwu: [0, 1],
                snout_mwu: [0, 2],
                snout_meu: [w, 2],
                snout_neu: [w, 1],
            }
        }
    }

    // needed for correct uv mapping
    if (l > 1) {
        vertices["snout_swd"] = [-w/2, -h/2, 0];
        vertices["snout_sed"] = [w/2, -h/2, 0];
        vertices["snout_swu"] = [-w/2, h/2, 0];
        vertices["snout_seu"] = [w/2, h/2, 0];

        faces["west_2"] = {
            vertices: [
                "snout_mwu",
                "snout_mwd",
                "snout_swd",
                "snout_swu",
            ],
            uv: {
                snout_mwu: [7, 4],
                snout_mwd: [7, 4 + h],
                snout_swd: [8, 4 + h],
                snout_swu: [8, 4],
            }
        };

        faces["east_2"] = {
            vertices: [
                "snout_seu",
                "snout_sed",
                "snout_med",
                "snout_meu",
            ],
            uv: {
                snout_seu: [7, 4],
                snout_sed: [7, 4 + h],
                snout_med: [8, 4 + h],
                snout_meu: [8, 4],
            }
        };

        faces["down_2"] = {
            vertices: [
                "snout_med",
                "snout_sed",
                "snout_swd",
                "snout_mwd",
            ],
            uv: {
                snout_med: [0, 3 + h],
                snout_sed: [0, 4 + h],
                snout_swd: [w, 4 + h],
                snout_mwd: [w, 3 + h],
            }
        },
        faces["up_2"] = {
            vertices: [
                "snout_mwu",
                "snout_swu",
                "snout_seu",
                "snout_meu",
            ],
            uv: {
                snout_mwu: [0, 0],
                snout_swu: [0, 1],
                snout_seu: [w, 1],
                snout_meu: [w, 0],
            }
        }
    }

    let snout = createGroup({
        id: "snout",
        name: "Snout",
        origin: origin,
        parent: "head",
        uuid: uuid
    });

    let texture = getTexture("base");

    let mesh = new Mesh({
        name: "Snout",
        origin,
        vertices
    }).addTo(snout);

    mesh.is_ears = true;

    var f = Object.values(faces).map( (face_spec) => new MeshFace(mesh, {
        texture,
        vertices: face_spec.vertices,
        uv: face_spec.uv
    }));

    mesh.resizable = false;

    mesh.addFaces(...f);
    mesh.init();

    Canvas.updateView({
        elements: [mesh],
        groups: [snout]
    })

    if (selected) snout.select();

    return {elements: [mesh], outliner: true}
}

function createProtrusions() {
    if (!Project.ears_settings.enabled) return {elements: [], outliner: true};
    let elements = [];
    if (Project.ears_settings.protrusions == "claws"
     || Project.ears_settings.protrusions == "both"
    ) {
        elements.push(createMesh(model_meshes["left_leg_claw"]));
        elements.push(createMesh(model_meshes["right_leg_claw"]));
        elements.push(createMesh(model_meshes[Project.skin_model == "alex" ? "left_arm_slim_claw" : "left_arm_claw"]));
        elements.push(createMesh(model_meshes[Project.skin_model == "alex" ? "right_arm_slim_claw" : "right_arm_claw"]));
    }

    if (Project.ears_settings.protrusions == "horn"
     || Project.ears_settings.protrusions == "both"
    ) {
        elements.push(createMesh(model_meshes.horn));
    }
    return {elements, outliner: true};
}

function createWings() {
    if (!Project.ears_settings.enabled || Project.ears_settings.wings_mode == "none") return {elements: [], textures: [], outliner: true};
    let textures = [];
    let elements = [];
    if (!getTexture("wing")) {
        textures.push(createEmptyTexture("wing", 20, 16));
    }
    if (Project.ears_settings.wings_mode == "symmetric_dual"
     || Project.ears_settings.wings_mode == "asymmetric_single_l"
    ) {
        elements.push(createMesh(model_meshes.wing_asymmetric_l));
    }
    if (Project.ears_settings.wings_mode == "symmetric_dual"
        || Project.ears_settings.wings_mode == "asymmetric_single_r"
    ) {
        elements.push(createMesh(model_meshes.wing_asymmetric_r));
    }
    if (Project.ears_settings.wings_mode == "symmetric_single") {
        elements.push(createMesh(model_meshes.wing_symmetric_single));
    }

    return {elements, textures, outliner: true};
}

function createCape(selected, uuid) {
    if (!Project.ears_settings.enabled || !Project.ears_settings.cape) return {elements: [], textures: [], outliner: true};
    let textures = [];
    if (!getTexture("cape")) {
        textures.push(createEmptyTexture("cape", 20, 16));
    }
    let cape = createGroup(model_groups.cape, uuid)
    let cape_mesh = createMesh(model_meshes.cape);
    if (selected) cape.select();
    return {elements: [cape_mesh], textures, outliner: true};
}

function createSimpleMesh(mesh_spec) {
    const [width, height, depth] = mesh_spec.size;
    const [px, py, pz] = mesh_spec.position;
    const [ox, oy, oz] = mesh_spec.origin;
    const dx = px - ox, dy = py - oy, dz = pz - oz;

    // n: north, z-; s: south, z+; w: west, x-; e: east, x+; d: down, y-; u: up, y+
    const vertices = {
        [`${mesh_spec.id}_nwd`]: [dx, dy, dz],
        [`${mesh_spec.id}_ned`]: [dx + width, dy, dz],
        [`${mesh_spec.id}_nwu`]: [dx, dy + height, dz],
        [`${mesh_spec.id}_neu`]: [dx + width, dy + height, dz],
        [`${mesh_spec.id}_swd`]: [dx, dy, dz + depth],
        [`${mesh_spec.id}_sed`]: [dx + width, dy, dz + depth],
        [`${mesh_spec.id}_swu`]: [dx, dy + height, dz + depth],
        [`${mesh_spec.id}_seu`]: [dx + width, dy + height, dz + depth]
    }

    var faces = {};

    var u, v, du, dv;

    if (mesh_spec.uv.down) {
        [u, v] = mesh_spec.uv.down.position;
        [du, dv] = mesh_spec.uv.down.size;
        faces.down = {
            vertices: [
                `${mesh_spec.id}_nwd`,
                `${mesh_spec.id}_ned`,
                `${mesh_spec.id}_sed`,
                `${mesh_spec.id}_swd`
            ],
            uv: {
                [`${mesh_spec.id}_nwd`]: [u + du, v + dv],
                [`${mesh_spec.id}_ned`]: [u, v + dv],
                [`${mesh_spec.id}_sed`]: [u, v],
                [`${mesh_spec.id}_swd`]: [u + du, v],
            }
        };
    }

    if (mesh_spec.uv.up) {
        [u, v] = mesh_spec.uv.up.position;
        [du, dv] = mesh_spec.uv.up.size;
        faces.up = {
            vertices: [
                `${mesh_spec.id}_nwu`,
                `${mesh_spec.id}_swu`,
                `${mesh_spec.id}_seu`,
                `${mesh_spec.id}_neu`
            ],
            uv: {
                [`${mesh_spec.id}_nwu`]: [u + du, v + dv],
                [`${mesh_spec.id}_swu`]: [u + du, v],
                [`${mesh_spec.id}_seu`]: [u, v],
                [`${mesh_spec.id}_neu`]: [u, v + dv],
            }
        };
    }


    if (mesh_spec.uv.west) {
        [u, v] = mesh_spec.uv.west.position;
        [du, dv] = mesh_spec.uv.west.size;
        faces.west = {
            vertices: [
                `${mesh_spec.id}_nwu`,
                `${mesh_spec.id}_nwd`,
                `${mesh_spec.id}_swd`,
                `${mesh_spec.id}_swu`
            ],
            uv: {
                [`${mesh_spec.id}_nwu`]: [u, v],
                [`${mesh_spec.id}_nwd`]: [u, v + dv],
                [`${mesh_spec.id}_swd`]: [u + du, v + dv],
                [`${mesh_spec.id}_swu`]: [u + du, v],
            }
        };
    };

    if (mesh_spec.uv.east) {
        [u, v] = mesh_spec.uv.east.position;
        [du, dv] = mesh_spec.uv.east.size;
        faces.east = {
            vertices: [
                `${mesh_spec.id}_seu`,
                `${mesh_spec.id}_sed`,
                `${mesh_spec.id}_ned`,
                `${mesh_spec.id}_neu`
            ],
            uv: {
                [`${mesh_spec.id}_seu`]: [u, v],
                [`${mesh_spec.id}_sed`]: [u, v + dv],
                [`${mesh_spec.id}_ned`]: [u + du, v + dv],
                [`${mesh_spec.id}_neu`]: [u + du, v],
            }
        };
    };

    if (mesh_spec.uv.north) {
        [u, v] = mesh_spec.uv.north.position;
        [du, dv] = mesh_spec.uv.north.size;
        faces.north = {
            vertices: [
                `${mesh_spec.id}_neu`,
                `${mesh_spec.id}_ned`,
                `${mesh_spec.id}_nwd`,
                `${mesh_spec.id}_nwu`
            ],
            uv: {
                [`${mesh_spec.id}_neu`]: [u, v],
                [`${mesh_spec.id}_ned`]: [u, v + dv],
                [`${mesh_spec.id}_nwd`]: [u + du, v + dv],
                [`${mesh_spec.id}_nwu`]: [u + du, v],
            }
        };
    }

    if (mesh_spec.uv.south) {
        [u, v] = mesh_spec.uv.south.position;
        [du, dv] = mesh_spec.uv.south.size;
        faces.south = {
            vertices: [
                `${mesh_spec.id}_swu`,
                `${mesh_spec.id}_swd`,
                `${mesh_spec.id}_sed`,
                `${mesh_spec.id}_seu`
            ],
            uv: {
                [`${mesh_spec.id}_swu`]: [u, v],
                [`${mesh_spec.id}_swd`]: [u, v + dv],
                [`${mesh_spec.id}_sed`]: [u + du, v + dv],
                [`${mesh_spec.id}_seu`]: [u + du, v],
            }
        };
    };

    var parent = getOrCreateGroup(mesh_spec.group);

    var mesh = new Mesh({
        name: mesh_spec.name,
        origin: mesh_spec.origin,
        vertices: vertices,
        rotation: mesh_spec.rotation
    }).addTo(parent);

    mesh.is_ears = mesh_spec.is_ears || false;

    var f = [];
    for (const [_, face_spec] of Object.entries(faces)) {
        const face = new MeshFace(mesh, {
            texture: getTexture(mesh_spec.texture),
            vertices: face_spec.vertices,
            uv: face_spec.uv
        })
        f.push(face);
        if (mesh_spec.invert_faces) {
            const inv_face = new MeshFace(mesh, {
                texture: getTexture(mesh_spec.texture),
                vertices: face_spec.vertices.toReversed(),
                uv: face_spec.uv
            })
            f.push(inv_face);
        }
    };

    mesh.resizable = false;

    mesh.addFaces(...f);
    mesh.init();
    Canvas.updateView({
        elements: [mesh],
        groups: [parent]
    })
    return mesh;
}

function createComplexMesh(mesh_spec) {
    var parent = getOrCreateGroup(mesh_spec.group);

    var mesh = new Mesh({
        name: mesh_spec.name,
        origin: mesh_spec.position,
        vertices: mesh_spec.vertices,
        rotation: mesh_spec.rotation
    }).addTo(parent);

    mesh.is_ears = mesh_spec.is_ears || false;

    var f = [];

    for (const [_, face_spec] of Object.entries(mesh_spec.faces)) {
        const face = new MeshFace(mesh, {
            texture: getTexture(mesh_spec.texture),
            vertices: face_spec.vertices,
            uv: face_spec.uv
        });
        f.push(face);
        if (mesh_spec.invert_faces) {
            const inv_face = new MeshFace(mesh, {
                texture: getTexture(mesh_spec.texture),
                vertices: face_spec.vertices.toReversed(),
                uv: face_spec.uv
            })
            f.push(inv_face);
        }
    };

    mesh.resizable = false;

    mesh.addFaces(...f);
    mesh.init();
    Canvas.updateView({
        elements: [mesh],
        groups: [parent]
    })
    return mesh;
}

const model_groups = {
    root: {
        id: "root",
        name: "Root",
        origin: [0, 18, 0],
    },
    upper_body: {
        id: "upper_body",
        name: "Upper Body",
        origin: [0, 12, 0],
        parent: "root"
    },
    body: {
        id: "body",
        name: "Body",
        origin: [0, 12, 0],
        parent: "upper_body"
    },
    wing_center: {
        id: "wing_center",
        name: "Wing",
        origin: [0, 18, 2],
        parent: "body",
        is_ears: true
    },
    wing_left: {
        id: "wing_left",
        name: "Wing (Left)",
        origin: [-2, 18, 2],
        parent: "body",
        is_ears: true
    },
    wing_right: {
        id: "wing_right",
        name: "Wing (Right)",
        origin: [2, 18, 2],
        parent: "body",
        is_ears: true
    },
    chest: {
        id: "chest",
        name: "Chest",
        origin: [0, 22, -2],
        parent: "body",
        is_ears: true
    },
    cape: {
        id: "cape",
        name: "Cape",
        origin: [0, 24, 2],
        parent: "body",
        is_ears: true
    },
    head: {
        id: "head",
        name: "Head",
        origin: [0, 24, 0],
        parent: "upper_body"
    },
    ears_top: {
        id: "ears_top",
        name: "Ears (Top)",
        origin: [0, 32, 0],
        parent: "head",
        is_ears: true
    },
    ears_left: {
        id: "ears_left",
        name: "Ears (Left)",
        origin: [-4, 28, 0],
        parent: "head",
        is_ears: true
    },
    ears_right: {
        id: "ears_right",
        name: "Ears (Right)",
        origin: [4, 28, 0],
        parent: "head",
        is_ears: true
    },
    horn: {
        id: "horn",
        name: "Horn",
        origin: [0, 32, -4],
        parent: "head",
        is_ears: true
    },
    left_arm: {
        id: "left_arm",
        name: "Left arm",
        origin: [-4, 24, 0],
        parent: "upper_body"
    },
    right_arm: {
        id: "right_arm",
        name: "Right arm",
        origin: [4, 24, 0],
        parent: "upper_body"
    },
    left_leg: {
        id: "left_leg",
        name: "Left leg",
        origin: [-2, 12, 0],
        parent: "root"
    },
    right_leg: {
        id: "right_leg",
        name: "Right leg",
        origin: [2, 12, 0],
        parent: "root"
    }
};

function createGroup(group_spec, uuid) {
    var group = new Group({
        name: group_spec.name,
        origin: group_spec.origin,
        rotation: group_spec.rotation,
        uuid: uuid
    }).init();
    group.id = group_spec.id;

    if(group_spec.parent) {
        let parent = getOrCreateGroup(group_spec.parent);
        if (!parent) {
            parent = createGroup(model_groups[parent])
        }
        group.addTo(parent);
    }

    return group.openUp();
}

function createVanillaGroups() {
    for (let k in model_groups) {
        if (!model_groups[k].is_ears) createGroup(model_groups[k]);
    }
}

function getGroup(id) {
    var groups = Group.all.filter((group) => group.id == id);
    return groups[0];
}

function getOrCreateGroup(id) {
    if (Format != format) return;
    let group = getGroup(id);
    if (!group) {
        group = createGroup(model_groups[id]);
    }
    return group;
}

function updateEars() {
    let head_group = getOrCreateGroup("head");
    head_group.children
        .filter((child) => child.name.includes("Ear"))
        .forEach((c) => c.remove());
    return createEars();
}

function updateTail(standalone = true) {
    let tail = getGroup("tail");
    let selected = tail?.selected;
    let uuid = tail?.uuid;
    tail?.remove();
    return createTail(selected, uuid);
}

function updateSnout(standalone = true) {
    let snout = getGroup("snout");
    let selected = snout?.selected;
    let uuid = snout?.uuid;
    snout?.remove();
    return createSnout(selected, uuid);
}

function updateProtrusions(standalone = true) {
    let claw_groups = ["left_arm", "right_arm", "left_leg", "right_leg"];
    claw_groups.map(getOrCreateGroup).forEach((group) => {
        group.children.filter((child) => {
            return child instanceof Mesh && child.name.endsWith("Claw");
        }).forEach((c) => c.remove());
    });

    let head_group = getOrCreateGroup("head");
    head_group.children.filter((child) => {
        return child instanceof Mesh && child.name.startsWith("Horn");
    }).forEach((c) => c.remove());
    return createProtrusions();
}

function updateWings(standalone = true) {
    let body_group = getOrCreateGroup("body");
    body_group.children.filter((child) => child.name.includes("Wing"))
        .forEach((c) => c.remove());
    return createWings();
}

function updateChest(standalone = true) {
    let chest_group = getGroup("chest");
    if (chest_group) {
        if (Project.ears_settings.enabled && Project.ears_settings.chest) {
            chest_group.rotation = [Project.ears_settings.chest_size * 45 / 100, 0, 0];
            Canvas.updateView({
                groups: [chest_group]
            });
            let elements = [...chest_group.children];
            return {elements, outliner: true}
        } else {
            chest_group.remove();
            return {elements: [], outliner: true}
        }
    } else {
        return createChest();
    }
}

function updateCape(standalone = true) {
    let cape = getGroup("cape");
    let selected = cape?.selected;
    let uuid = cape?.uuid;
    cape?.remove();
    return createCape(selected, uuid);
}



function updateAllEarsFeatures() {
    let elements = [];
    let textures = [];
    elements.push(...(updateEars().elements));
    elements.push(...(updateProtrusions().elements));
    elements.push(...(updateTail().elements));
    elements.push(...(updateSnout().elements));
    elements.push(...(updateChest().elements));
    let wings_change = updateWings();
    elements.push(...(wings_change.elements));
    textures.push(...(wings_change.textures))
    let cape_change = updateCape();
    elements.push(...(cape_change.elements));
    textures.push(...(cape_change.textures));
    return {elements, textures, outliner: true};
}

function updateArmsWidth() {
    let uuids = {};
    let left_arm = getOrCreateGroup("left_arm");
    let right_arm = getOrCreateGroup("right_arm");

    left_arm.children.map((c) => c).forEach((c) => {uuids[c.name] = c.uuid; c.remove()});
    right_arm.children.map((c) => c).forEach((c) => {uuids[c.name] = c.uuid; c.remove()});

    let elements = [];

    if (Project.skin_model == "alex") {
        elements.push(createMesh(model_meshes.left_arm_slim, uuids[model_meshes.left_arm_slim.name]));
        elements.push(createMesh(model_meshes.left_arm_slim_outer, uuids[model_meshes.left_arm_slim_outer.name]));
        if (Project.ears_settings.enabled && (Project.ears_settings.protrusions == "claws" || Project.ears_settings.protrusions == "both")) {
            elements.push(createMesh(model_meshes.left_arm_slim_claw, uuids[model_meshes.left_arm_slim_claw.name]));
        }
        elements.push(createMesh(model_meshes.right_arm_slim, uuids[model_meshes.right_arm_slim.name]));
        elements.push(createMesh(model_meshes.right_arm_slim_outer, uuids[model_meshes.right_arm_slim_outer.name]));
        if (Project.ears_settings.enabled && (Project.ears_settings.protrusions == "claws" || Project.ears_settings.protrusions == "both")) {
            elements.push(createMesh(model_meshes.right_arm_slim_claw, uuids[model_meshes.right_arm_slim_claw.name]));
        }
    } else {
        elements.push(createMesh(model_meshes.left_arm, uuids[model_meshes.left_arm.name]));
        elements.push(createMesh(model_meshes.left_arm_outer, uuids[model_meshes.left_arm_outer.name]));
        if (Project.ears_settings.enabled && (Project.ears_settings.protrusions == "claws" || Project.ears_settings.protrusions == "both")) {
            elements.push(createMesh(model_meshes.left_arm_claw, uuids[model_meshes.left_arm_claw.name]));
        }
        elements.push(createMesh(model_meshes.right_arm, uuids[model_meshes.right_arm.name]));
        elements.push(createMesh(model_meshes.right_arm_outer, uuids[model_meshes.right_arm_outer.name]));
        if (Project.ears_settings.enabled && (Project.ears_settings.protrusions == "claws" || Project.ears_settings.protrusions == "both")) {
            elements.push(createMesh(model_meshes.right_arm_claw, uuids[model_meshes.right_arm_claw.name]));
        }
    }

    return elements
}

function getAllEarsMeshes() {
 return Mesh.all.filter((m) => m.is_ears)
}

const panel_css = `#panel_ears_manipulator {
    #ears_toolbars_container {
    overflow-x: hidden;
    overflow-y: scroll;
    padding: 0 4px;

    .toolbar {
        .toolbar_menu {
            display: none;
        }

        .content .tool {
            flex-grow: 1;
        }
    }
    }

    label.keybinding_label {
        display: none;
    }

    .panel_handle label {
        text-overflow: ellipsis;
        span {
            white-space:nowrap;
        }
    }

    .toolbar {
        overflow: visible;

        .content {
            .tool i {
                height: 22px;
                margin: 4px;
            }

            .tool.has_label {
                .tooltip {
                    display: none;
                }

                label {
                    padding-right: 8px;
                }
            }

            .tool.wide {
                width: auto;
            }

            > .tool.enabled {
                border: none;
                i {
                    background-color: var(--color-accent);
                }
            }

            .tooltip {
                height: auto;
                white-space: normal;
                margin-top: 0;
                top: 30px;
            }

            .nslide_tool {
                margin-left: 2px;
                margin-right: 2px;
                display: flex;
                position: relative;
                white-space: nowrap;

                .nslide_arrow {
                    margin: 0 !important;
                }

                i {
                    margin: 4px auto;
                }

                .na_right {
                    right: 0;
                }

                .na_left {
                    left: 0;
                }
            }

            .nslide_tool.has_label {
                justify-content: space-between;

                .nslide {
                    width: 50%;
                    float: right;
                }
            }

            .nslide {
                min-width: 72px;
            }

            bb-select {
                text-overflow: ellipsis;
                width: 50%;
                float: right;
            }
        }
    }
}
`

BBPlugin.register('ears_manipulator', {
    title: "Blockbench Ears Manipulator",
    author: "Gudf",
    icon: "icon",
    description: "Edit skins to use with unascribed's Ears mod.",
    tags: ["Minecraft: Java Edition", "Ears"],
    version: "0.0.1",
    variant: "desktop",
    await_loading: true,
    creation_date: "2024-07-13",
    onload() {
        var css = Blockbench.addCSS(panel_css);
        toDelete.push(css);

        let project_done_loading = new Property(ModelProject, "boolean", "project_done_loading", {default: false, exposed: false, condition: {formats: [FORMAT_ID]}});
        let ears_settings = new Property(ModelProject, "instance", "ears_settings", {default: {
                enabled: false,
                ears_mode: "none",
                ears_anchor: "center",
                protrusions: "none",
                tail_mode: "none",
                tail_segments: 1,
                tail_bend_1: 0,
                tail_bend_2: 0,
                tail_bend_3: 0,
                tail_bend_4: 0,
                snout: false,
                snout_width: 1,
                snout_height: 1,
                snout_length: 1,
                snout_offset: 0,
                chest: false,
                chest_size: 1,
                wings_mode: "none",
                wings_animation: "normal",
                cape: false,
                emissive: false
            },
            exposed: false,
            condition: {formats: [FORMAT_ID]}
        }
        );
        let ears_alfalfa = new Property(ModelProject, 'instance', 'ears_alfalfa', {default: {entries: {}}, exposed: false, condition: {formats: [FORMAT_ID]}});
        let group_ids = new Property(Group, 'string', 'id', {condition: {formats: [FORMAT_ID]}});
        let ears_meshes = new Property(Mesh, 'boolean', 'is_ears', {default: false, condition: {formats: [FORMAT_ID]}});

        // Action to hide layers, similar to the one available in the skin format
        let layer_toggle = new Action('ears_toggle_skin_layers', {
            name: "Toggle Skin Layer",
            icon: 'layers_clear',
            category: 'edit',
            condition: {formats: [FORMAT_ID]},
            click() {
                let edited = Mesh.all.filter(m => m.name.includes("Layer"));
                if (!edited.length) return;
                Undo.initEdit({elements: edited});
                let visibility = !edited[0].visibility;
                edited.forEach(m => m.visibility = visibility);
                Undo.finishEdit("Toggle skin layer");
                Canvas.updateVisibility();
            }
        })
        toDelete.push(layer_toggle);

        let ears_visibility_toggle = new Action('ears_toggle_parts', {
            name: "Toggle Ears Parts' Visibility",
            icon: 'layers_clear',
            category: 'edit',
            condition: {formats: [FORMAT_ID]},
            click() {
                let edited = Mesh.all.filter(m => m.is_ears);
                if (!edited.length) return;
                Undo.initEdit({elements: edited});
                let visibility = !edited[0].visibility;
                edited.forEach(m => m.visibility = visibility);
                Undo.finishEdit(`${visibility ? "Show" : "Hide"} all Ears parts`);
                Canvas.updateVisibility();
            }
        })
        toDelete.push(layer_toggle);

        let outliner = Toolbars.outliner;
        let layer_toggle_index = outliner.children.findIndex(e => e.id == 'toggle_skin_layer');
        if (layer_toggle_index >= 0) {
            outliner.children.splice(layer_toggle_index, 0, layer_toggle, ears_visibility_toggle);
        }

        // Add Ears manipulator menu
        /// Toolbar items

        //// Misc
        let ears_enabled = new Toggle("ears_enabled", {
            name: "Enable Ears Mod",
            icon: "done",
            value: false,
            onChange(val) {
                let base_texture = getTexture("base");
                Undo.initEdit({
                    elements: getAllEarsMeshes(),
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        enabled: true
                    }
                })
                Project.ears_settings.enabled = val;
                let changes = updateAllEarsFeatures();
                writeEarsSettingsToTexture(base_texture);
                Undo.finishEdit(`${val ? "Enable" : "Disable"} Ears`,
                    {
                        elements: changes.elements,
                        outliner: true,
                        textures: [base_texture, ...changes.textures],
                        bitmap: true,
                        ears_settings: {
                            enabled: true
                        }
                    });
                Panels.ears_manipulator.updateAllToolbars();
            },
            get() {return Project.ears_settings.enabled;}
        });
        ears_enabled.addLabel(true);
        toDelete.push(ears_enabled);

        let slim_model = new Toggle("slim_model", {
            name: "Slim model",
            icon: "done",
            value: false,
            onChange: ((val) => {
                let left_arm = getOrCreateGroup("left_arm");
                let right_arm = getOrCreateGroup("right_arm");
                let elements = [...left_arm.children, ...right_arm.children];

                Undo.initEdit({elements, outliner: true, skin_model: true})
                Project.skin_model = (val ? "alex" : "steve");
                elements = updateArmsWidth();
                Undo.finishEdit("Change skin model", {elements, outliner: true, skin_model: true})
            }),
            get() {return Project.skin_model == "alex"}
        });
        slim_model.addLabel(true);
        toDelete.push(slim_model);

        //// Ears
        let ears_mode = new BarSelect("ears_mode", {
            name: "Ears Mode",
            value: "none",
            options: {
                none: "None",
                above: "Above",
                sides: "Sides",
                out: "Out",
                around: "Around",
                floppy: "Floppy",
                cross: "Cross",
                tall: "Tall",
                tall_cross: "Tall Cross",
                behind: {
                    name: "Behind",
                    condition: (() => this.value == "behind")
                }
            },
            onChange(sel) {
                let head_group = getOrCreateGroup("head");
                let ears = head_group.children.filter((child) => child.name.includes("Ear"));
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements: ears.map(g => g.children).flat(),
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        ears_mode: true
                    }
                });

                let previous = Project.ears_settings.ears_mode;
                Project.ears_settings.ears_mode = sel.value;
                let changes = updateEars();
                writeEarsSettingsToTexture(base_texture);

                Undo.finishEdit(`${previous == "none" ? "Enable" : (sel.value != "none" ? "Update" : "Disable")} ears`, {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        ears_mode: true
                    }
                });

                Toolbars.ears_toolbar.update(true);
            },
            get() {
                return Project.ears_settings.ears_mode;
            }
        });
        ears_mode.addLabel(true);
        toDelete.push(ears_mode);

        let ears_anchor = new BarSelect("ears_anchor", {
            name: "Ears Anchor",
            condition: (() => ears_mode.value != "none"),
            value: "center",
            options: {
                center: "Center",
                front: "Front",
                back: "Back"
            },
            onChange(sel) {
                let head_group = getOrCreateGroup("head");
                let ears = head_group.children.filter((child) => child.name.includes("Ear"));
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements: ears.map(g => g.children).flat(),
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        ears_anchor: true
                    }
                });
                Project.ears_settings.ears_anchor = sel.value;
                let changes = updateEars();
                writeEarsSettingsToTexture(base_texture);

                Undo.finishEdit("Update ears anchor", {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        ears_anchor: true
                    }
                });
            },
            get() {return Project.ears_settings.ears_anchor}
        });
        ears_anchor.addLabel(true);
        toDelete.push(ears_anchor);

        //// Protrusions
        let protrusions = new BarSelect("protrusions", {
            name: "Protrusions",
            value: "none",
            options: {
                none: "None",
                claws: "Claws",
                horn: "Horn",
                both: "Claws and Horn"
            },
            onChange(sel) {
                let elements = Mesh.all.filter((m) => m.name.includes("Claw") || m.name.includes("Horn"))
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        protrusions: true
                    }
                });

                previous = Project.ears_settings.protrusions;

                Project.ears_settings.protrusions = sel.value;
                let changes = updateProtrusions();
                writeEarsSettingsToTexture(base_texture);

                Undo.finishEdit(`${previous == "none" ? "Enable" : (sel.value != "none" ? "Update" : "Disable")} protrusions`, {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        protrusions: true
                    }
                });
            },
            get() {return Project.ears_settings.protrusions}
        });
        protrusions.addLabel(true);
        toDelete.push(protrusions);

        //// Tail
        let tail_mode = new BarSelect("tail_mode", {
            name: "Tail Mode",
            value: "none",
            options: {
                none: "None",
                down: "Down",
                back: "Back",
                up: "Up",
                vertical: "Vertical"
            },
            onChange(sel) {
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements: Mesh.all.filter((m) => m.name.includes("Tail")),
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        tail_mode: true
                    }
                });

                let previous = Project.ears_settings.tail_mode;

                Project.ears_settings.tail_mode = sel.value;
                let changes = updateTail();
                writeEarsSettingsToTexture(base_texture);

                Undo.finishEdit(`${previous == "none" ? "Enable" : (sel.value != "none" ? "Update" : "Disable")} tail`, {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        tail_mode: true
                    }
                });

                Toolbars.tail_toolbar.update();
                Toolbars.tail_bends_toolbar.update();
            }
        });
        tail_mode.addLabel(true);
        toDelete.push(tail_mode);

        let tail_segments = new NumSlider("tail_segments", {
            name: "Segments",
            label: true,
            color: "white",
            condition: (() => tail_mode.value != "none"),
            settings: {
                default: 1,
                min: 1,
                max: 4,
                step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_segments: true
                    }
                });
            },
            onChange(val) {
                Project.ears_settings.tail_segments = val;
                Toolbars.tail_bends_toolbar.update();
                updateTail();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.finishEdit("Change number of tail segments", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_segments: true
                    }
                });
            }
        });
        toDelete.push(tail_segments);

        let tail_bend_1 = new NumSlider("tail_bend_1", {
            name: "First segment bend",
            label: false,
            color: "white",
            condition: (() => tail_segments.value >= 1),
            settings: {
                default: 0,
                min: -90,
                max: 90,
                step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_1: true
                    }
                });
            },
            onChange(val) {
                Project.ears_settings.tail_bend_1 = val;
                updateTail();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.finishEdit("Change first tail bend", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_1: true
                    }
                });
            }
        });
        toDelete.push(tail_bend_1);

        let tail_bend_2 = new NumSlider("tail_bend_2", {
            name: "Second segment bend",
            label: false,
            color: "white",
            condition: (() => tail_segments.value >= 2),
            settings: {
                default: 0,
                min: -90,
                max: 90,
                step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_2: true
                    }
                });
            },
            onChange(val) {
                Project.ears_settings.tail_bend_2 = val;
                updateTail();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.finishEdit("Change second tail bend", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_2: true
                    }
                });
            }
        });
        toDelete.push(tail_bend_2);

        let tail_bend_3 = new NumSlider("tail_bend_3", {
            name: "Third segment bend",
            label: false,
            color: "white",
            condition: (() => tail_segments.value >= 3),
            settings: {
                default: 0,
                min: -90,
                max: 90,
                step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_3: true
                    }
                });
            },
            onChange(val) {
                Project.ears_settings.tail_bend_3 = val;
                updateTail();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.finishEdit("Change first tail bend", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_3: true
                    }
                });
            }
        });
        toDelete.push(tail_bend_3);

        let tail_bend_4 = new NumSlider("tail_bend_4", {
            name: "Fourth segment bend",
            label: false,
            color: "white",
            condition: (() => tail_segments.value >= 4),
            settings: {
                default: 0,
                min: -90,
                max: 90,
                step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_4: true
                    }
                });
            },
            onChange(val) {
                Project.ears_settings.tail_bend_4 = val;
                updateTail();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Tail"));
                Undo.finishEdit("Change first tail bend", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        tail_bend_4: true
                    }
                });
            }
        });
        toDelete.push(tail_bend_4);

        let snout_enabled = new Toggle("snout_enabled", {
            name: "Snout",
            icon: "done",
            value: false,
            onChange(val) {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        snout: true
                    }
                });

                Project.ears_settings.snout = val;
                let changes = updateSnout();
                writeEarsSettingsToTexture(getTexture("base"));

                Undo.finishEdit(`${val ? "Enable" : "Disable"} snout`, {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        snout: true
                    }
                });

                Toolbars.snout_size_toolbar.update();
            }
        });
        snout_enabled.addLabel(true);
        toDelete.push(snout_enabled);

        let snout_width = new NumSlider("snout_width", {
            name: "Snout Width",
            label: false,
            color: "white",
            condition: (() => snout_enabled.value),
            settings: {
                default: 1,
                min: 1,
                max: 7,
                step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_width: true
                    }
                })
            },
            onChange(val) {
                Project.ears_settings.snout_width = val;
                updateSnout();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.finishEdit("Change snout width", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_width: true
                    }
                })
            }
        });
        toDelete.push(snout_width);

        let snout_offset;

        let snout_height = new NumSlider("snout_height", {
            name: "Snout Height",
            label: false,
            color: "white",
            condition: (() => snout_enabled.value),
            settings: {
                default: 1,
                    min: 1,
                    max: 4,
                    step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_height: true,
                        snout_offset: true
                    }
                })
            },
            onChange(val) {
                Project.ears_settings.snout_height = val;
                if (Project.ears_settings.snout_offset > 8 - val) {
                    Project.ears_settings.snout_offset = 8 - val;
                    snout_offset.setValue(8 - val, false);
                }
                updateSnout();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.finishEdit("Change snout height", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_height: true,
                        snout_offset: true
                    }
                })
            }
        });
        toDelete.push(snout_height);

        let snout_length = new NumSlider("snout_length", {
            name: "Snout Length",
            label: false,
            color: "white",
            condition: (() => snout_enabled.value),
            settings: {
                default: 1,
                    min: 1,
                    max: 6,
                    step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_length: true
                    }
                })
            },
            onChange(val) {
                Project.ears_settings.snout_length = val;
                updateSnout();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.finishEdit("Change snout length", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_length: true
                    }
                })
            }
        });
        toDelete.push(snout_length);

        snout_offset = new NumSlider("snout_offset", {
            name: "Snout Offset",
            label: false,
            color: "white",
            condition: (() => snout_enabled.value),
            settings: {
                default: 0,
                    min: 0,
                    max: 7,
                    step: 1
            },
            onBefore() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_offset: true
                    }
                })
            },
            onChange(val) {
                if (val > 8 - snout_height.value) {
                    val = 8 - snout_height.value;
                    this.setValue(val, false);
                }
                Project.ears_settings.snout_offset = val;
                updateSnout();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                let elements = Mesh.all.filter((m) => m.name.includes("Snout"));
                Undo.finishEdit("Change snout offset", {
                    elements,
                    outliner: true,
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        snout_offset: true
                    }
                })
            }
        });
        toDelete.push(snout_offset);

        const chest_enabled = new Toggle("chest_enabled", {
            name: "Chest",
            icon: "done",
            value: false,
            onChange(val) {
                let elements = Mesh.all.filter((m) => m.name.includes("Chest"));
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        chest: true
                    }
                });

                Project.ears_settings.chest = val;
                let changes = updateChest();
                writeEarsSettingsToTexture(getTexture("base"));

                Undo.finishEdit(`${val ? "Enable" : "Disable"} chest`, {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        chest: true
                    }
                });

                Toolbars.chest_toolbar.update();
            }
        });
        chest_enabled.addLabel(true);
        toDelete.push(chest_enabled);

        const chest_size = new NumSlider("chest_size", {
            name: "Chest Size",
            label: true,
            color: "white",
            condition: (() => chest_enabled.value),
            settings: {
                default: 1,
                min: 1,
                max: 100,
                step: 1,
            },
            onBefore() {
                Undo.initEdit({
                    group: getGroup("chest"),
                    textures: [getTexture("base")],
                    bitmap: true,
                    ears_settings: {
                        chest_size: true
                    }
                });
            },
            onChange(val) {
                Project.ears_settings.chest_size = val;
                updateChest();
                writeEarsSettingsToTexture(getTexture("base"));
            },
            onAfter() {
                Undo.finishEdit("Change chest size");
            }
        });
        toDelete.push(chest_size);

        const wings_mode = new BarSelect("wings_mode", {
            name: "Wings Mode",
            value: "none",
            options: {
                none: "None",
                symmetric_dual: "Symmetric Dual",
                symmetric_single: "Symmetric Single",
                asymmetric_single_l: "Asymmetric Single (Left)",
                asymmetric_single_r: "Asymmetric Single (Right)"
            },
            onChange(sel) {
                let elements = Mesh.all.filter((m) => m.name.includes("Wing"));
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        wings_mode: true
                    }
                });

                let previous = Project.ears_settings.wings_mode;

                Project.ears_settings.wings_mode = sel.value;
                let changes = updateWings();
                writeEarsSettingsToTexture(base_texture);

                Undo.finishEdit(`${previous == "none" ? "Enable" : sel.value != "none" ? "Update" : "Disable"} wing(s)`, {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture, ...changes.textures],
                    bitmap: true,
                    ears_settings: {
                        wings_mode: true
                    }
                });

                Toolbars.wings_toolbar.update();
            }
        });
        wings_mode.addLabel(true);
        toDelete.push(wings_mode);

        const wings_animation = new BarSelect("wings_animation", {
            name: "Wings Animation",
            value: "normal",
            condition: (() => wings_mode.value != "none"),
            options: {
                normal: "Normal",
                none: "None"
            },
            onChange(sel) {
                Project.ears_settings.wings_animation = sel.value;
                let base = getTexture("base");
                Undo.initEdit({textures: [base]});
                writeEarsSettingsToTexture(base);
                Undo.finishEdit(`${sel.value == "none" ? "Disable": "Enable"} wing(s) animation`);
            }
        });
        wings_animation.addLabel(true);
        toDelete.push(wings_animation);

        const cape_enabled = new Toggle("cape_enabled", {
            name: "Cape",
            icon: "done",
            value: false,
            onChange: ((val) => {
                let elements = Mesh.all.filter((m) => m.name.includes("Cape"));
                let base_texture = getTexture("base");

                Undo.initEdit({
                    elements,
                    outliner: true,
                    textures: [base_texture],
                    bitmap: true,
                    ears_settings: {
                        cape: true
                    }
                });

                Project.ears_settings.cape = val;
                let changes = updateCape();
                writeEarsSettingsToTexture(base_texture);

                Undo.finishEdit(`${val ? "Enable" : "Disable"} cape`, {
                    elements: changes.elements,
                    outliner: true,
                    textures: [base_texture, ...changes.textures],
                    bitmap: true,
                    ears_settings: {
                        cape: true
                    }
                });
            })
        });
        cape_enabled.addLabel(true);
        toDelete.push(cape_enabled);

        function setBarItemsValues(slim, ears_settings) {
            slim_model.value = slim;
            slim_model.updateEnabledState();
            ears_enabled.value = ears_settings.enabled;
            ears_enabled.updateEnabledState();
            ears_mode.set(ears_settings.ears_mode);
            ears_anchor.set(ears_settings.ears_anchor);
            protrusions.set(ears_settings.protrusions);
            tail_mode.set(ears_settings.tail_mode);
            tail_segments.setValue(ears_settings.tail_segments);
            tail_bend_1.setValue(ears_settings.tail_bend_1);
            tail_bend_2.setValue(ears_settings.tail_bend_2);
            tail_bend_3.setValue(ears_settings.tail_bend_3);
            tail_bend_4.setValue(ears_settings.tail_bend_4);
            snout_enabled.value = ears_settings.snout;
            snout_enabled.updateEnabledState();
            snout_width.setValue(ears_settings.snout_width);
            snout_height.setValue(ears_settings.snout_height);
            snout_length.setValue(ears_settings.snout_length);
            snout_offset.setValue(ears_settings.snout_offset);
            chest_enabled.value = ears_settings.chest;
            chest_enabled.updateEnabledState();
            chest_size.setValue(ears_settings.chest_size);
            wings_mode.set(ears_settings.wings_mode);
            wings_animation.set(ears_settings.wings_animation);
            cape_enabled.value = ears_settings.cape;
            cape_enabled.updateEnabledState();
            panel.updateAllToolbars();
        }

        /// Toolbars
        misc_skin_settings_toolbar = new Toolbar("misc_skin_settings_toolbar", {
            id: "misc_skin_settings_toolbar",
            name: "Misc Skin Settings",
            label: false,
            children: [
                "ears_enabled",
                "slim_model"
            ]
        });

        ears_toolbar = new Toolbar("ears_toolbar", {
            id: "ears_toolbar",
            name: "Ears settings",
            label: true,
            condition: (() => ears_enabled.value),
            children: [
                "ears_mode",
                '#',
                "ears_anchor"
            ]
        });

        protrusions_toolbar = new Toolbar("protrusions_toolbar", {
            id: "protrusions_toolbar",
            name: "Protrusions settings",
            label: true,
            condition: (() => ears_enabled.value),
            children: [
                "protrusions"
            ]
        });

        tail_toolbar = new Toolbar("tail_toolbar", {
            id: "tail_toolbar",
            name: "Tail settings",
            label: true,
            condition: (() => ears_enabled.value),
            children: [
                "tail_mode",
                '#',
                "tail_segments"
            ]
        });

        tail_bends_toolbar = new Toolbar("tail_bends_toolbar", {
            id: "tail_bends_toolbar",
            name: "Tail bends",
            label: true,
            condition: (() => tail_mode.value != "none" && ears_enabled.value),
            children: [
                "tail_bend_1",
                "tail_bend_2",
                "tail_bend_3",
                "tail_bend_4"
            ]
        });

        snout_toolbar = new Toolbar("snout_toolbar", {
            id: "snout_toolbar",
            name: "Snout",
            label: true,
            condition: (() => ears_enabled.value),
            children: [
                "snout_enabled"
            ]
        });

        snout_size_toolbar = new Toolbar("snout_size_toolbar", {
            id: "snout_size_toolbar",
            name: "Snout Size",
            label: true,
            condition: (() => snout_enabled.value && ears_enabled.value),
            children: [
                "snout_width",
                "snout_height",
                "snout_length",
                "snout_offset"
            ]
        });

        chest_toolbar = new Toolbar("chest_toolbar", {
            id: "chest_toolbar",
            name: "Chest",
            label: true,
            condition: (() => ears_enabled.value),
            children: [
                "chest_enabled",
                '#',
                "chest_size"
            ]
        });

        wings_toolbar = new Toolbar("wings_toolbar", {
            id: "wings_toolbar",
            name: "Wings",
            label: true,
            condition: (() => ears_enabled.value),
            children: [
                "wings_mode",
                '#',
                "wings_animation"
            ]
        });

        cape_toolbar = new Toolbar("cape_toolbar", {
            id: "cape_toolbar",
            name: "Cape",
            label: true,
            condition: (() => ears_enabled.value),
            children: [
                "cape_enabled"
            ]
        })

        /// Panel
        panel = new Panel("ears_manipulator", {
            id: "ears_manipulator",
            name: "Ears mod settings",
            icon: "settings",
            growable: true,
            condition: {
                formats: [FORMAT_ID],
                modes: ["edit", "paint"]
            },
            display_condition: {
                modes: ["edit", "paint"]
            },
            expand_button: true,
            default_side: "left",
            toolbars: [
                misc_skin_settings_toolbar
            ]
        });

        const toolbars = [
            ears_toolbar,
            protrusions_toolbar,
            tail_toolbar,
            tail_bends_toolbar,
            snout_toolbar,
            snout_size_toolbar,
            chest_toolbar,
            wings_toolbar,
            cape_toolbar
        ]

        var toolbars_container = Interface.createElement('div', {id: 'ears_toolbars_container'}, []);
        panel.node.append(toolbars_container);
        for (var toolbar of toolbars) {
            if (toolbar.label) {
                let label = Interface.createElement('p', {class: 'panel_toolbar_label'}, tl(toolbar.name));
                toolbars_container.append(label);
                toolbar.label_node = label;
            }
            toolbars_container.append(toolbar.node);
            panel.toolbars.push(toolbar);
        }

        panel.updateAllToolbars = () => {for (var toolbar of panel.toolbars) toolbar.update();};
        toDelete.push(panel);

        const ears_codec = new Codec('ears_codec', {
            name: "Ears skin",
            extension: "png",
            export_options: {
                export_alfalfa: {type: 'checkbox', label: 'Include Alfalfa (Wings & Cape)', value: true},
                include_author: {type: 'checkbox', label: "Embed author name in Alfalfa", value: true},
                author: {type: 'text', label: "Author"}
            },
            remember: true,
            compile(options) {
                if (options === undefined) {
                    options = Object.assign(this.getExportOptions(), options);
                }
                if (!options.export_alfalfa) {
                    return getTexture("base").canvas.toDataURL();
                }

                if (options.include_author && options.author) {
                    let encoder = new TextEncoder();
                    Project.ears_alfalfa.entries["author"] = bytesToB64(encoder.encode(options.author));
                }

                if (Project.ears_settings.wings_mode != "none" && getTexture("wing")) {
                    Project.ears_alfalfa.entries["wing"] = extractDataFromDataUrl(getTexture("wing").canvas.toDataURL());
                }

                if (Project.ears_settings.cape && getTexture("cape")) {
                    Project.ears_alfalfa.entries["cape"] = extractDataFromDataUrl(getTexture("cape").canvas.toDataURL());
                }

                let canvas = Interface.createElement("canvas", {height: "64", width: "64"});
                let ctx = canvas.getContext("2d", {willReadFrequently: true});

                let base_skin_data = getTexture("base").ctx.getImageData(0, 0, 64, 64);
                ctx.putImageData(base_skin_data, 0, 0);

                let alfalfa_success = writeAlfalfaToCanvasCtx(Project.ears_alfalfa, ctx);

                if (!alfalfa_success) {
                    // Warning
                }
                return canvas.toDataURL();
            }
        })
        toDelete.push(ears_codec);

        model_options = {
            wide: "Wide model",
            slim: "Slim model"
        }

        const dialog = new Dialog({
            title: "New Ears skin",
            id: 'ears_skin',
            form: {
                model: {
                    label: 'Model type',
                    type: 'select',
                    options: model_options
                },
                ears_enabled: {
                    type: 'checkbox',
                    label: 'Enable Ears mod features',
                    value: true
                },
                texture: {
                    label: 'Load existing Ears skin',
                    type: 'file',
                    extensions: ['png'],
                    readtype: 'image',
                    filetype: 'PNG',
                    return_as: 'file'
                }
            },
            async onFormChange(result) {
                if (!this.previous_texture_path || this.previous_texture_path == result.texture.path) return;
                if (result.texture) {
                    this.previous_texture_path = result.texture.path;
                    var canvas = Interface.createElement('canvas', {height: "64", width: "64"});
                    var ctx = canvas.getContext("2d");
                    var d = this;
                    const ears_check = new Promise((resolve) => {
                        var image = new Image(64, 64);
                        image.onload = function () {
                            ctx.drawImage(image, 0, 0);
                            var ears_magic = ctx.getImageData(0, 32, 1, 1).data;
                            if (   (ears_magic[0] == 0x3F && ears_magic[1] == 0x23 && ears_magic[2] == 0xD8) // Ears data V0
                                || (ears_magic[0] == 0xEA && ears_magic[1] == 0x25 && ears_magic[2] == 0x01) // Ears data V1
                            ) {
                                d.setFormValues({'ears_enabled': true}, false);
                            } else {
                                d.setFormValues({'ears_enabled': false}, false);
                            }
                            resolve();
                        };
                        image.src = result.texture.path;
                    });
                    await ears_check;
                    canvas.remove();
                }
            },
            async onConfirm(result) {
                if(newProject(format)){
                    Project.ears_settings.enabled = result.ears_enabled;
                    Project.skin_model = (result.model == "slim") ? "alex" : "steve";

                    var root_group = createVanillaGroups("root");

                    const vanilla_parts = [
                        "head",
                        "head_outer",
                        "body",
                        "body_outer",
                        Project.skin_model == "alex" ? "left_arm_slim" : "left_arm",
                        Project.skin_model == "alex" ? "left_arm_slim_outer" : "left_arm_outer",
                        Project.skin_model == "alex" ? "right_arm_slim" : "right_arm",
                        Project.skin_model == "alex" ? "right_arm_slim_outer" : "right_arm_outer",
                        "left_leg",
                        "left_leg_outer",
                        "right_leg",
                        "right_leg_outer"
                    ];

                    if (result.texture) {
                        var canvas = Interface.createElement('canvas', {height: 64, width: 64});
                        var canvas_ctx = canvas.getContext("2d", {willReadFrequently: true});
                        const texture_loaded = new Promise(resolve => {
                            let image = new Image(64, 64);
                            image.onload = function () {
                                canvas_ctx.drawImage(image, 0, 0);
                                resolve()
                            };
                            image.src = result.texture.path;
                        });

                        await texture_loaded;

                        if (Project.ears_settings.enabled) {
                            const ears_square = canvas_ctx.getImageData(0, 32, 4, 4);
                            parseEarsSettings(ears_square.data);
                            writeEarsSettings(ears_square.data);
                            canvas_ctx.putImageData(ears_square, 0, 32);
                        }

                        Project.ears_alfalfa = loadAlfalfaFromCanvasCtx(canvas_ctx);

                        const base_texture = new Texture({name: "base", id: "base", width: 64, height: 64})
                            .fromDataURL(canvas.toDataURL())
                            .add();
                        base_texture.uv_width = 64;
                        base_texture.uv_height = 64;

                        if (Project.ears_alfalfa.entries["wing"]) {
                            const wing_texture = new Texture({name: "wing", id: "wing", width: 20, height: 16})
                                .fromDataURL(b64ToDataUrl(Project.ears_alfalfa.entries["wing"], "image/png"))
                                .add();
                            wing_texture.uv_width = 20;
                            wing_texture.uv_height = 16;
                        }

                        if (Project.ears_alfalfa.entries["cape"]) {
                            const wing_texture = new Texture({name: "cape", id: "cape", width: 20, height: 16})
                                .fromDataURL(b64ToDataUrl(Project.ears_alfalfa.entries["cape"], "image/png"))
                                .add();
                            wing_texture.uv_width = 20;
                            wing_texture.uv_height = 16;
                        }

                        canvas.remove();

                        createEars();
                        createTail();
                        createSnout();
                        createProtrusions();
                        createWings();
                        createChest();
                        createCape();

                        Canvas.updateAll();
                    } else {
                        const base_texture = new Texture({name: "base", id: "base", width: 64, height: 64})
                            .fromDataURL(b64ToDataUrl(Project.skin_model == "alex" ? default_texture_slim : default_texture_wide, "image/png"))
                            .add();
                        base_texture.uv_width = 64;
                        base_texture.uv_height = 64;
                    }

                    setBarItemsValues(Project.skin_model == "alex", Project.ears_settings);

                    for (const part of vanilla_parts) {
                        let m = createMesh(model_meshes[part]);
                        if (!result.texture && part.endsWith("outer")) m.visibility = false;
                    }

                    Canvas.updateVisibility();

                    Project.project_done_loading = true;
                }
            }
        });

        function onParsed(data) {
            setBarItemsValues(Project.skin_model == "alex", Project.ears_settings);
        }

        Codecs.project.on('parsed', onParsed);

        eventListeners.push({
            addedTo: Codecs.project,
            e: 'parsed',
            callback: onParsed
        });

        function onCreateUndoSave({save, aspects}) {
            if (Project.format.id != FORMAT_ID) return;
            if (aspects && aspects.ears_settings) {
                save.ears_settings = {};
                for (let key in aspects.ears_settings) {
                    if (aspects.ears_settings[key]) save.ears_settings[key] = Project.ears_settings[key];
                }
            }

            if (aspects && aspects.skin_model) {
                save.skin_model = Project.skin_model;
            }
        }

        Blockbench.on("create_undo_save", onCreateUndoSave);
        eventListeners.push({
            addedTo: Blockbench,
            e: "create_undo_save",
            callback: onCreateUndoSave
        });

        function onLoadUndoSave({save, reference, mode}) {
            if (Project.format.id != FORMAT_ID) return;
            if (save.ears_settings) {
                for (let [k, v] of Object.entries(save.ears_settings)) {
                    Project.ears_settings[k] = v;
                }
            }
            if (save.skin_model) {
                Project.skin_model = save.skin_model
            }
            setBarItemsValues(Project.skin_model == "alex", Project.ears_settings)
        }

        Blockbench.on("load_undo_save", onLoadUndoSave);
        eventListeners.push({
            addedTo: Blockbench,
            e: "load_undo_save",
            callback: onLoadUndoSave
        });

        // Add new model format
        format = new ModelFormat(FORMAT_ID, {
            icon: 'icon-player',
            name: 'Ears Skin',
            description: 'Player model for the Ears mod.',
            category: 'minecraft',
            target: ['Minecraft: Java Edition', 'Ears'],
            show_on_start_screen: true,
            single_texture: false,
            per_texture_uv_size: true,
            meshes: true,
            texture_folder: false,
            edit_mode: true,
            paint_mode: true,
            pose_mode: true,
            animation_mode: true,
            centered_grid: true,
            bone_rig: true,
            render_sides: "front",
            codec: ears_codec,
            new() {
                dialog.show();
                return true;
            },
            onActivation() {
                if (Project.project_done_loading) {
                    setBarItemsValues(Project.skin_model == "alex", Project.ears_settings);
                };
            },
            onSetup() {
                Modes.options.paint.select();
            }
        });
        toDelete.push(format);
    },
    onunload() {
        for (const deletable of toDelete) deletable.delete();
        for (var {addedTo, e, callback} of eventListeners) {
            addedTo.removeListener(e, callback);
        }
        let outliner = Toolbars.outliner;
        var to_remove;
        while ((to_remove = outliner.children.findIndex(e => e.id.startsWith("ears_toggle_"))) >= 0) {
            outliner.children.splice(to_remove, 1);
        }
    }
});

})();
