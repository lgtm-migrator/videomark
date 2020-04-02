// eslint-disable-next-line import/no-unresolved
import uuidv4 from "uuid/v4";
// eslint-disable-next-line import/no-unresolved
import msgpack from "msgpack-lite";

import Config from "./Config";
import ResourceTiming from "./ResourceTiming";
import VideoData from "./VideoData";
import { useStorage } from "./Storage";
import { saveTransferSize, underQuotaLimit, saveQuotaLimitStarted, fetchAndStorePeakTimeLimit, underPeakTimeLimit, stopPeakTimeLimit } from "./StatStorage";
import { version } from "../../../package.json";

async function set_max_bitrate(new_video) {
  const bitrate_control = Config.get_bitrate_control();
  const quota_bitrate = Config.get_quota_bitrate();
  if (quota_bitrate) saveQuotaLimitStarted(new Date().getTime());

  let bitrate;
  if (bitrate_control && quota_bitrate) bitrate = Math.min(bitrate_control, quota_bitrate);
  else bitrate = bitrate_control || quota_bitrate;
  let resolution = Config.get_resolution_control();

  const peak_time_limit = await fetchAndStorePeakTimeLimit();
  if (peak_time_limit) {
    bitrate    = Math.min(bitrate,    peak_time_limit.bitrate);
    resolution = Math.min(resolution, peak_time_limit.resolution);
  }

  if (bitrate_control || quota_bitrate || resolution || peak_time_limit) new_video.set_max_bitrate(bitrate, resolution);
  else if(underQuotaLimit() || underPeakTimeLimit()) {
      new_video.set_default_bitrate();
      saveQuotaLimitStarted(undefined);
      stopPeakTimeLimit();
  }
}

export default class SessionData {
  constructor() {
    this.version = version;
    this.startTime = 0;
    this.endTime = 0;
    this.userAgent =
      window &&
      (window.sodium ? window.sodium.userAgent : window) &&
      (window.navigator ? window.navigator.userAgent : "");
    this.appVersion = this.userAgent.substr(this.userAgent.indexOf("/") + 1);
    this.sequence = 0;
    this.video = [];
    this.latest_qoe_update_count = 0;
    this.hostToIp = {};
    this.resource = new ResourceTiming();
  }

  async init() {
    const settings = Config.get_settings();
    let session = Config.get_default_session();
    if (
      session === undefined ||
      settings === undefined ||
      !(Date.now() < session.expires)
    ) {
      const expiresIn =
        settings === undefined ? NaN : Number(settings.expires_in);
      session = {
        id: uuidv4(),
        expires:
          Date.now() +
          (Number.isFinite(expiresIn)
            ? expiresIn
            : Config.get_default_session_expires_in())
      };
      if (Config.is_mobile()) {
        window.sodium.storage.local.set({ session });
      } else {
        window.postMessage(
          {
            type: "FROM_SODIUM_JS",
            method: "set_session",
            ...session
          },
          "*"
        );
      }
    }

    this.session_id = session.id;
    // eslint-disable-next-line no-console
    console.log(`VIDEOMARK: New Session start Session ID[${this.session_id}]`);

    this.locationIp();
    this.alt_session_message();
  }

  // eslint-disable-next-line camelcase
  get_session_id() {
    return this.session_id;
  }

  /**
   * 計測対象のvideo
   */
  // eslint-disable-next-line camelcase
  get_main_video() {
    return this.video.find(e => e.is_main_video());
  }

  /**
   * videoの利用可否
   */
  // eslint-disable-next-line camelcase
  get_video_availability() {
    // eslint-disable-next-line camelcase
    const main_video = this.get_main_video();
    // eslint-disable-next-line camelcase
    if (main_video === undefined) return false;
    return main_video.is_available();
  }

  /**
   * 各videoのクオリティ情報の更新
   */
  // eslint-disable-next-line camelcase
  update_quality_info() {
    this.video.forEach(e => e.update());
  }

  /**
   * videoリストの更新
   * @param {HTMLCollection} elms
   */
  // eslint-disable-next-line camelcase
  set_video_elms(elms) {
    Array.prototype.forEach.call(elms, elm => {
      if (!this.video.find(e => e.video_elm === elm)) {
        // eslint-disable-next-line camelcase
        const video_id = uuidv4();
        try {
          // eslint-disable-next-line camelcase
          const new_video = new VideoData(elm, video_id);
          new_video.read_settings();
          /* eslint-disable no-console */
          console.log(`VIDEOMARK: new video found uuid[${video_id}]`);
          set_max_bitrate(new_video);
          this.video.push(new_video);
        } catch (err) {
          // どのタイプでもない
        }
      }
    });
    const removing = this.video.filter(
      e =>
        !Array.prototype.find.call(elms, elm => elm === e.video_elm) ||
        !e.is_stay()
    );
    removing.forEach(e => {
      e.clear();
      this.video.splice(this.video.indexOf(e), 1);
    });
  }

  async start() {
    for (;;) {
      // --- main video --- //
      const main_video = this.get_main_video();
      if (!main_video) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve =>
          setTimeout(() => resolve(), Config.get_check_state_interval())
        );
        // eslint-disable-next-line no-continue
        continue;
      }

      console.log(
        `VIDEOMARK: STATE CHANGE found main video ${main_video.get_video_id()}`
      );

      // --- play start --- //
      let start_time = -1;
      for (; start_time === -1 && main_video === this.get_main_video(); ) {
        // eslint-disable-next-line no-await-in-loop
        await SessionData.event_wait(
          main_video.video_elm,
          "play",
          Config.get_check_state_interval()
        );
        start_time = main_video.get_start_time();
      }

      // eslint-disable-next-line no-continue
      if (main_video !== this.get_main_video()) continue;

      console.log(`VIDEOMARK: STATE CHANGE play ${new Date(start_time)}`);

      try {
        // eslint-disable-next-line no-await-in-loop, no-underscore-dangle
        await this._play_started(main_video);
      } catch (err) {
        console.log(`VIDEOMARK: ${err}`);
      }
    }
  }

  // eslint-disable-next-line camelcase
  async _play_started(main_video) {
    const qoe_request_start =
      Config.get_trans_interval() * Config.get_send_data_count_for_qoe() -
      Config.get_prev_count_for_qoe();
    const qoe_request_timeout =
      qoe_request_start + Config.get_max_count_for_qoe();

    let i = 0;
    let qoe = null;

    // --- latest qoe --- //
    for (; !qoe && i < qoe_request_timeout; i += 1) {
      let data = false;
      let request = false;

      if (main_video.is_available()) {
        data = i % Config.get_trans_interval() === 0;
        request = i > qoe_request_start;
      }

      // eslint-disable-next-line no-await-in-loop, no-underscore-dangle
      qoe = await this._transaction(
        main_video,
        data,
        request,
        Config.get_check_state_interval()
      );

      if (main_video !== this.get_main_video()) return;
    }

    console.log(`VIDEOMARK: STATE CHANGE latest qoe computed ${qoe}`);

    // --- 通常処理 --- //
    for (; ; i += 1) {
      let data = false;
      let request = false;

      if (main_video.is_available()) {
        data = i % Config.get_trans_interval() === 0;
        request =
          i % (Config.get_trans_interval() * Config.get_latest_qoe_update()) ===
          0;
      }

      // eslint-disable-next-line no-await-in-loop, no-underscore-dangle
      qoe = await this._transaction(
        main_video,
        data,
        request,
        Config.get_check_state_interval()
      );

      if (main_video !== this.get_main_video()) return;
    }
  }

  async _transaction(main_video, data, request, wait) {
    let qoe = null;

    const tasks = [];

    if (main_video.is_available()) {
      if (data) {
        // --- send to fluent --- //
        // eslint-disable-next-line no-underscore-dangle
        this._send_data(main_video);
      }
      if (request && main_video.is_calculatable()) {
        // --- request qoe --- //
        // eslint-disable-next-line no-loop-func
        tasks.push(
          (async () => {
            // eslint-disable-next-line no-underscore-dangle
            qoe = await this._request_qoe(main_video);
            if (qoe)
              main_video.add_latest_qoe({
                date: Date.now(),
                qoe
              });
          })()
        );
        if (Config.is_quality_control()) {
          tasks.push(
            (async () => {
              // eslint-disable-next-line no-underscore-dangle
              const recommend_bitrate = await this._request_recommend_bitrate(
                main_video
              );
              if (recommend_bitrate) main_video.set_quality(recommend_bitrate);
            })()
          );
        }
      }
      // --- save to storage --- //
      // eslint-disable-next-line no-underscore-dangle
      this._store_session(main_video);
    }

    // --- wait next --- //
    // eslint-disable-next-line no-loop-func
    tasks.push(new Promise(resolve => setTimeout(() => resolve(), wait)));

    // eslint-disable-next-line no-await-in-loop
    await Promise.all(tasks);

    return qoe;
  }

  // eslint-disable-next-line camelcase
  async _send_data(video) {
    try {
      // eslint-disable-next-line no-underscore-dangle
      const body = msgpack.encode(this._to_json(video));
      if (body.length > Config.get_max_send_size())
        console.warn(`VIDEOMARK: Too large payload packed body size is ${body.length}`);
      const ret = await fetch(Config.get_fluent_url(), {
        method: "POST",
        headers: {
          "Content-type": "application/msgpack"
        },
        body
      });
      if (!ret.ok) {
        throw new Error("fluent response was not ok.");
      }
    } catch (err) {
      console.error(`VIDEOMARK: ${err}`);
    }
  }

  // eslint-disable-next-line camelcase
  async _request_qoe(video) {
    try {
      const ret = await fetch(`${Config.get_sodium_server_url()}/latest_qoe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ids: {
            session_id: this.session_id,
            video_id: video.get_video_id()
          }
        })
      });
      if (!ret.ok) {
        throw new Error("SodiumServer(qoe) response was not ok.");
      }
      const json = await ret.json();
      const qoe = Number.parseFloat(json.qoe);
      return Number.isNaN(qoe) ? null : qoe;
    } catch (err) {
      console.error(`VIDEOMARK: ${err}`);
      return null;
    }
  }

  // eslint-disable-next-line camelcase
  async _request_recommend_bitrate(video) {
    try {
      const ret = await fetch(
        `${Config.get_sodium_server_url()}/recommend_bitrate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ids: {
              session_id: this.session_id,
              video_id: video.get_video_id()
            }
          })
        }
      );
      if (!ret.ok) {
        throw new Error("SodiumServer(tqapi) response was not ok.");
      }
      const json = await ret.json();
      const recommendBitrate = Number.parseFloat(json.recommendBitrate);
      return Number.isNaN(recommendBitrate) ? null : recommendBitrate;
    } catch (err) {
      console.error(`VIDEOMARK: ${err}`);
      return null;
    }
  }

  // eslint-disable-next-line camelcase
  async _store_session(video) {
    const storage = useStorage({
      sessionId: this.session_id,
      videoId: video.get_video_id()
    });
    const [prevResource, resource] = this.resource.collect();
    await storage.save({
      user_agent: this.userAgent,
      location: this.alt_location || window.location.href,
      transfer_size: resource.transferSize,
      media_size: video.get_media_size(),
      domain_name: video.get_domain_name(),
      start_time: video.get_start_time(),
      end_time: -1,
      thumbnail: this.alt_thumbnail || video.get_thumbnail(),
      title: video.get_title(),
      calc: video.is_calculatable(),
      log: [
        ...(storage.cache.log || []).filter(a => !("qoe" in a)),
        ...video.get_latest_qoe(),
        {
          date: Date.now(),
          quality: {
            ...video.get_quality(),
            viewport: video.get_viewport(),
            resolution: video.get_resolution(),
            timing: video.get_timing()
          }
        }
      ]
        .sort(({ date: ad }, { date: bd }) => ad - bd)
        .slice(-Config.max_log)
    });

    await saveTransferSize(resource.transferSize - prevResource.transferSize);
  }

  /**
   * 送信データフォーマットに変換
   */
  // eslint-disable-next-line camelcase
  _to_json(video) {
    this.startTime = this.endTime;
    this.endTime = performance.now();
    this.sequence += 1;

    const param = {
      version: this.version,
      date: new Date().toISOString(),
      startTime: this.startTime,
      endTime: this.endTime,
      session: this.session_id,
      location: this.alt_location || window.location.href,
      locationIp: this.hostToIp[new URL(window.location.href).host],
      userAgent: this.userAgent,
      sequence: this.sequence,
      calc: video.is_calculatable(),
      service: video.get_service(),
      video: [video.get()],
      resource_timing: []
    };

    const netinfo = {};
    [
      "downlink",
      "downlinkMax",
      "effectiveType",
      "rtt",
      "type",
      "apn",
      "plmn",
      "sim"
    ].forEach(e => {
      if (navigator.connection[e] === Infinity) {
        netinfo[e] = Number.MAX_VALUE;
      } else if (navigator.connection[e] === -Infinity) {
        netinfo[e] = Number.MIN_VALUE;
      } else {
        netinfo[e] = navigator.connection[e];
      }
    });
    param.netinfo = netinfo;

    return param;
  }

  async locationIp() {
    const url = new URL(window.location.href);
    const ip = await new Promise(resolve => {
      const listener = event => {
        if (
          event.data.host !== url.host ||
          event.data.type !== "CONTENT_SCRIPT_JS"
        )
          return;
        window.removeEventListener("message", listener);
        resolve(event.data.ip);
      };
      window.addEventListener("message", listener);
      window.postMessage({
        host: url.host,
        method: "get_ip",
        type: "FROM_SODIUM_JS"
      });
    });
    this.hostToIp[url.host] = ip;
  }

  // eslint-disable-next-line camelcase
  static event_wait(elm, type, ms) {
    let eventResolver;
    const event = new Promise(resolve => {
      eventResolver = resolve;
      elm.addEventListener(type, resolve, false);
    });
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), ms));
    return new Promise(async resolve => {
      const ret = await Promise.race([event, timeout]);
      elm.removeEventListener(type, eventResolver, false);
      resolve(ret);
    });
  }

  alt_session_message() {
    const allowHosts = ["tver.jp", "fod.fujitv.co.jp"];
    const allowVideoHosts = ["i.fod.fujitv.co.jp"];

    if (window.top === window) {
      if (!allowHosts.includes(window.location.hostname)) return;

      const location = window.location.href;
      const thumbnail = (
        document.querySelector("meta[property='og:image']") || {}
      ).content;
      const session = { location, thumbnail };

      window.addEventListener("message", event => {
        const { data, source, origin } = event;
        if (data.type !== "ALT_SESSION_MESSAGE_REQ") return;
        if (!allowVideoHosts.includes(new URL(origin).hostname)) return;
        source.postMessage(
          { type: "ALT_SESSION_MESSAGE_RES", ...session },
          origin
        );
      });
    } else {
      if (!allowVideoHosts.includes(window.location.hostname)) return;

      const eventResolver = event => {
        const { data, origin } = event;
        if (data.type !== "ALT_SESSION_MESSAGE_RES") return;
        if (!allowHosts.includes(new URL(origin).hostname)) return;
        const { location, thumbnail } = data;
        this.alt_location = location;
        this.alt_thumbnail = thumbnail;
        window.removeEventListener("message", eventResolver);
      };
      window.addEventListener("message", eventResolver);
      window.top.postMessage({ type: "ALT_SESSION_MESSAGE_REQ" }, "*");
    }
  }
}
