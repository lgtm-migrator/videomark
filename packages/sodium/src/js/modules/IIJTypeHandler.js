import { parse } from 'mpd-parser';

import Config from "./Config";

import GeneralTypeHandler from "./GeneralTypeHandler";

const IIJ_MPD_PATH = "http://edge.iijlive.ipcasting.jp/contents/live/ele/tw/index.mpd";

export default class IIJTypeHandler extends GeneralTypeHandler {

    // eslint-disable-next-line camelcase
    static async hook_iij() {
        // eslint-disable-next-line no-restricted-globals
        const { host } = new URL(location.href)
        if (host !== "pr.iij.ad.jp") return;

        /* MPD 取得のタイミングがホックより早いため自分で取得を行う */
        try {
            const ret = await fetch(IIJ_MPD_PATH);
            const body = await ret.text();
            /* mpd-parser で parse すると framerate が失われるため予め値を取得する */
            let fps;
            try {
                const { groups: { frameRate } } = /frameRate="(?<frameRate>\S+)"/.exec(body);
                const [frame, unit] = frameRate.split("/")
                fps = Math.floor(Number(frame) / Number(unit));
            } catch (e) {
                fps = -1;
            }
            IIJTypeHandler.sodiumAdaptiveFmts = parse(body, IIJ_MPD_PATH);
            IIJTypeHandler.sodiumAdaptiveFmts.framerate = fps;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`VIDEOMARK: IIJ failed to get adaptive formats ${e}`);
        }

        IIJTypeHandler.hook_iij_request();
    }

    // eslint-disable-next-line camelcase
    static hook_iij_request() {
        const origOpen = XMLHttpRequest.prototype.open
        const origSend = XMLHttpRequest.prototype.send

        // eslint-disable-next-line func-names, prefer-arrow-callback
        XMLHttpRequest.prototype.open = function (...args) {
            ([, this.sodiumURL] = args);
            this.addEventListener(`load`, (event) => {
                this.sodiumEnd = performance.now();
                this.sodiumEndDate = Date.now();
                try {
                    this.sodiumEndUnplayedBuffer = IIJTypeHandler.get_unplayed_buffer_size();
                    setTimeout(() => {  //  playerオブジェクトがない可能性がある、XHR後のバッファロード処理があるため、1000ms スリープする
                        IIJTypeHandler.add_throughput_history({
                            url: this.sodiumURL,
                            downloadTime: Math.floor(this.sodiumEnd - this.sodiumStart),
                            throughput: Math.floor(event.loaded * 8 / (this.sodiumEnd - this.sodiumStart) * 1000),
                            downloadSize: Number.parseFloat(event.loaded),
                            start: this.sodiumStartDate,
                            startUnplayedBufferSize: this.sodiumStartUnplayedBuffer,
                            loadStart: this.sodiumLoadStartDate,
                            loadStartUnplayedBufferSize: this.sodiumLoadStartUnplayedBuffer,
                            end: this.sodiumEndDate,
                            endUnplayedBufferSize: this.sodiumEndUnplayedBuffer,
                            itag: this.sodiumItag
                        });
                    }, 1000);

                } catch (e) { return };

                // eslint-disable-next-line no-console
                console.log(`VIDEOMARK: load [URL: ${this.sodiumURL
                    }, contents: ${event.loaded
                    }, duration(ms): ${this.sodiumEnd - this.sodiumStart
                    }, duration(Date): ${new Date(this.sodiumStartDate)} - ${new Date(this.sodiumEndDate)
                    }, UnplayedBufferSize: ${this.sodiumStartUnplayedBuffer} - ${this.sodiumEndUnplayedBuffer
                    }, throughput: ${Math.floor(event.loaded * 8 / (this.sodiumEnd - this.sodiumStart) * 1000)
                    }, itag: ${this.sodiumItag}]`);
            });
            this.addEventListener(`loadstart`, () => {
                this.sodiumLoadStart = performance.now();
                this.sodiumLoadStartDate = Date.now();
                this.sodiumLoadStartUnplayedBuffer = IIJTypeHandler.get_unplayed_buffer_size();
            });
            return origOpen.apply(this, args);
        }
        // eslint-disable-next-line func-names, prefer-arrow-callback
        XMLHttpRequest.prototype.send = function (...args) {
            this.sodiumStart = performance.now();
            this.sodiumStartDate = Date.now();
            this.sodiumStartUnplayedBuffer = IIJTypeHandler.get_unplayed_buffer_size();
            this.sodiumItag = IIJTypeHandler.get_video_representation_id();
            return origSend.apply(this, args);
        }
    }

    // eslint-disable-next-line camelcase
    static add_throughput_history(throughput) {
        IIJTypeHandler.throughputHistories.push(throughput);
        IIJTypeHandler.throughputHistories = IIJTypeHandler.throughputHistories.slice(-Config.get_max_throughput_history_size());
    }

    // eslint-disable-next-line camelcase
    static get_unplayed_buffer_size() {
        let unplayedBufferSize;
        try {
            const received = IIJTypeHandler.get_receive_buffer();
            const current = IIJTypeHandler.get_current_time();
            if (Number.isNaN(received) || Number.isNaN(current)) throw new Error(`NaN`);
            unplayedBufferSize = (received - current) * 1000;
            if (unplayedBufferSize < 0)
                throw new Error(`unplayedBufferSize is negative value`);
        } catch (e) {
            unplayedBufferSize = 0;
        }
        return Math.floor(unplayedBufferSize);
    }

    // eslint-disable-next-line camelcase
    static get_receive_buffer() {
        let ret = -1;
        try {
            const { buffered } = document.querySelector("video");
            ret = buffered.end(buffered.length - 1);

        } catch (e) {
            // do nothing
        }
        return ret;
    }

    // eslint-disable-next-line camelcase
    static get_current_time() {
        return document.querySelector("video").currentTime
    }

    // eslint-disable-next-line camelcase
    static get_video_representation_id() {
        try {
            const video = document.querySelector("video");
            const { representationId } = IIJTypeHandler
                .play_list_form_adaptive_fmts()
                .find(e => e.videoHeight === video.videoHeight &&
                    e.videoWidth === video.videoWidth);
            return representationId;
        } catch (e) {
            return undefined;
        }
    }

    // eslint-disable-next-line camelcase
    static play_list_form_adaptive_fmts() {
        try {
            const {
                mediaGroups: { AUDIO: { audio: { main: { playlists: audio } } } },
                playlists: video
            } = IIJTypeHandler.sodiumAdaptiveFmts
            const videoRepArry = video.map(e => {
                const {
                    attributes: {
                        NAME: representationId,
                        BANDWIDTH: bps,
                        CODECS: codec,
                        RESOLUTION: {
                            width: videoWidth,
                            height: videoHeight
                        }
                    },
                    segments: [{
                        duration: chunkDuration,
                        resolvedUri: serverIp
                    }]
                } = e;
                return {
                    type: "video",
                    representationId,
                    bps,
                    videoWidth,
                    videoHeight,
                    container: "mp4",
                    codec,
                    fps: IIJTypeHandler.sodiumAdaptiveFmts.framerate,
                    chunkDuration: chunkDuration * 1000,
                    serverIp: new URL(serverIp).host
                }
            });
            const audioRepArray = audio.map(e => {
                const {
                    attributes: {
                        NAME: representationId,
                        BANDWIDTH: bps,
                        CODECS: codec
                    },
                    segments: [{
                        duration: chunkDuration,
                        resolvedUri: serverIp
                    }]
                } = e;
                return {
                    type: "audio",
                    representationId,
                    bps,
                    videoWidth: -1,
                    videoHeight: -1,
                    container: "mp4",
                    codec,
                    fps: -1,
                    chunkDuration: chunkDuration * 1000,
                    serverIp: new URL(serverIp).host
                }
            });
            return videoRepArry.concat(audioRepArray);

        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`VIDEOMARK: IIJ failed to get adaptive formats ${e}`);
            return []
        }
    }

    // eslint-disable-next-line camelcase, class-methods-use-this
    get_duration() {
        return -1;
    }

    // eslint-disable-next-line camelcase
    get_bitrate() {
        try {
            const video = this.get_video_bitrate();
            const { bps: audio } = this
                .get_play_list_info()
                .find(e => e.videoHeight === -1 && e.videoHeight === -1 && e.type === "audio");
            return video + audio;
        } catch (e) {
            return -1;
        }
    }

    // eslint-disable-next-line camelcase
    get_video_bitrate() {
        try {
            const { bps } = this
                .get_play_list_info()
                .find(e => e.videoHeight === this.elm.videoHeight && e.videoWidth === this.elm.videoWidth);
            return bps;
        } catch (e) {
            return -1;
        }
    }

    // eslint-disable-next-line camelcase, class-methods-use-this
    get_framerate() {
        return IIJTypeHandler.sodiumAdaptiveFmts.framerate;
    }

    // eslint-disable-next-line camelcase, class-methods-use-this
    get_video_title() {
        return undefined;
    }

    // eslint-disable-next-line camelcase, class-methods-use-this
    get_video_thumbnail() {
        return undefined;
    }

    // eslint-disable-next-line camelcase, class-methods-use-this
    get_play_list_info() {
        return IIJTypeHandler.play_list_form_adaptive_fmts();
    }

    // eslint-disable-next-line camelcase, class-methods-use-this
    get_throughput_info() {
        try {
            return IIJTypeHandler.throughputHistories
                .splice(0, IIJTypeHandler.throughputHistories.length)
                .filter(h => h.itag)
                .reduce((acc, cur) => {
                    let bitrate;
                    try {
                        ({ bitrate } = this.get_play_list_info()
                            .find(e => e.representationId === cur.itag))
                    } catch (e) {
                        bitrate = -1;
                    }
                    acc.push({
                        downloadTime: cur.downloadTime,
                        throughput: cur.throughput,
                        downloadSize: cur.downloadSize,
                        start: cur.start,
                        startUnplayedBufferSize: cur.startUnplayedBufferSize,
                        loadStart: cur.loadStart,
                        loadStartUnplayedBufferSize: cur.loadStartUnplayedBufferSize,
                        end: cur.end,
                        endUnplayedBufferSize: cur.endUnplayedBufferSize,
                        bitrate,
                        representationId: cur.itag
                    });
                    return acc;
                }, []);
        } catch (e) {
            return []
        }
    }

    // eslint-disable-next-line camelcase
    get_codec_info() {
        try {
            const { codec } = this
                .get_play_list_info()
                .find(e => e.videoHeight === this.elm.videoHeight && e.videoWidth === this.elm.videoWidth);
            return codec;
        } catch (e) {
            return undefined;
        }
    }

    // eslint-disable-next-line camelcase, class-methods-use-this
    get_representation() {
        return IIJTypeHandler.get_video_representation_id();
    }
}
IIJTypeHandler.sodiumAdaptiveFmts = null;
IIJTypeHandler.throughputHistories = [];
