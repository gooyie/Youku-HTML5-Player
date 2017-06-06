/*
  Code Source: https://github.com/spacemeowx2/DouyuHTML5Player/blob/b5a54240f1b31d53a8530af83444b10027fe6dca/src/hookfetch.js
*/

let channelId = 0;
let localConnection;

class StreamReader {

  constructor(port) {
    this._channelId = channelId++ & 0x3ff;
    let dataChannel = localConnection.createDataChannel('dataChannel', {id: this._channelId});
    this._dataChannel = dataChannel;
    this._port = port;
    this._cansend = false;
    this._onCanSend = () => this._cansend = true;

    dataChannel.onopen = this._onopen.bind(this);
    dataChannel.onclose = this._onclose.bind(this);
    dataChannel.onerror = this._onerror.bind(this);
    dataChannel.onmessage = this._onmessage.bind(this);
  }

  read() {
    return new Promise((resolve, reject) => {
      this._readCallback = resolve;
      this._errorCallback = reject;
      this._send('read');
    })
  }

  cancel() {
    return new Promise((resolve, reject) => {
      this._cancelCallback = resolve;
      this._errorCallback = reject;
      this._send('cancel');
    })
  }

  _onopen(event) {
    console.log(`[dataChannel] opened data channel ${this._channelId}`);
  }

  _onclose(event) {
    console.log(`[dataChannel] closed data channel ${this._channelId}`);
  }

  _send(...args) {
    if (this._cansend) {
      this._dataChannel.send(...args);
    } else {
      this._onCanSend = () => {
        this._cansend = true;
        this._dataChannel.send(...args);
      };
    }
  }

  _onmessage(event) {
    // console.log('[dataChannel] received', event.data);
    let data = event.data;

    if (data instanceof ArrayBuffer) {
      this._readCallback({done: false, value: new Uint8Array(data)});
    } else if (data === 'done') {
      this._dataChannel.close();
      this._readCallback({done: true, value: undefined});
    } else if (data === 'canceled') {
      this._dataChannel.close();
      this._cancelCallback();
    } else if (data === 'remoteOpened') {
      this._port('stream', [this._channelId]).then(this._onCanSend);
    }
  }

  _onerror(event) {
    console.error(`[dataChannel] error of data channel ${this._channelId}`, event);
    this._errorCallback(new Error(event));
  }

}

function createConnection() {
  let port = chrome.runtime.connect({name: 'signaling'});

  let localConnection = new RTCPeerConnection();
  let initChannel = localConnection.createDataChannel('initChannel', {id: channelId++ & 0x3ff});

  window.addEventListener('unload', () => {
    localConnection.close();
    port.disconnect();
  });

  localConnection.onicecandidate = (event) => {
    if (event.candidate) {
      port.postMessage(event.candidate.toJSON());
    }
  }

  initChannel.onopen = (event) => {
    console.log('[initChannel] opened', event);
    initChannel.close();
  }

  initChannel.onclose = (event) => {
    console.log('[initChannel] closed', event);
  }

  port.onMessage.addListener((msg = {}) => {
    console.log('[signaling]', msg);
      try {
        if (msg.status && msg.status === 'connected') {
          localConnection.createOffer().then(offer => {
            port.postMessage(offer.toJSON());
            localConnection.setLocalDescription(offer);
          });
        } else if (msg.type && msg.type === 'answer') {
          localConnection.setRemoteDescription(new RTCSessionDescription(msg));
        } else if (msg.candidate) {
          localConnection.addIceCandidate(new RTCIceCandidate(msg));
        }
      } catch (err) {
        console.error(err.stack);
      }
  });

  port.onDisconnect.addListener(port => {
    console.log('[signaling] disconnected');
  });

  return localConnection;
}

if( isChrome && location.protocol=='https:' ){
  console.log('chrome+https环境，替换fetch');
  localConnection = createConnection();

(function () {
  let self = this
  const convertHeader = function convertHeader(headers) {
    let out = new Headers()
    for (let key of Object.keys(headers)) {
      out.set(key, headers[key])
    }
    return out
  }
	function Headers2Object (headers){
		let out = {},
		keys = headers.keys(),
    next;
		while((next = keys.next() )&& !next.done) {
			out[next.value] = headers.get(next.value);
		}
    return out;
	}
  const wrapPort = function wrapPort (port) {
    let curMethod = ''
    let curResolve = null
    let curReject = null
    port.onMessage.addListener(msg => {
      if (msg.method === curMethod) {
        if (msg.err) {
          curReject(msg.err)
        } else {
          curResolve.apply(null, msg.args)
        }
      } else {
        //console.error('wtf?')
      }
    })
    return function (method, args) {
      return new Promise((resolve, reject) => {
        curMethod = method
        curResolve = resolve
        curReject = reject
        port.postMessage({
          method: method,
          args: args
        })
      })
    }
  }
  const bgFetch = function bgFetch(...args) {
    const port = wrapPort(chrome.runtime.connect({name: "fetch"}))
    if(args[1].headers != undefined)
      args[1].headers = Headers2Object(args[1].headers);
    return port('fetch', args).then(r => {
      let hasReader = false
      const requireReader = function (after) {
        if (hasReader) {
          return Promise.resolve().then(after)
        } else {
          return port('body.getReader').then(() => hasReader = true).then(after)
        }
      }
      r.json = () => port('json')
      r.headers = convertHeader(r.headers)
      r.body = {
        getReader () {
          console.log('[getReader]', args[0])
          return new StreamReader(port)
          // return {
            // read () {
              // return requireReader(() => port('reader.read')).then(r => {
                // if(r.value!=undefined)
                  // r.value = new Uint8Array(r.value)
                // return r
              // })
            // },
            // cancel () {
              // return requireReader(() => port('reader.cancel'))
            // }
          // }
        }
      }
      return r
    })
  }
  const oldBlob = self.Blob
  const newBlob = function newBlob(a, b) {
    a[0] = `(${hookFetchCode})();${a[0]}`
    return new oldBlob(a, b)
  }
  if(self.document !== undefined) {
    if (self.Blob !== newBlob) {
      self.Blob = newBlob
    }
  }
  (function () {
    if (self.fetch !== bgFetch) {
      self.fetch = bgFetch
    }
  })();
})();
}