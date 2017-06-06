/*
  fetch hooking code from https://github.com/spacemeowx2/DouyuHTML5Player/blob/b5a54240f1b31d53a8530af83444b10027fe6dca/src/background.js#L8
*/

let connections = new Map();
let dataChannels = new WeakMap();

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'signaling') return;

  const tabId = port.sender.tab.id;
  console.log(`[${tabId}][signaling] connected`);
  let remoteConnection;

  port.onMessage.addListener((msg = {}) => {
    console.log(`[${tabId}][signaling]`, msg);
    (async () => {
      try {
        if (msg.type && msg.type === 'offer') {
          remoteConnection = new RTCPeerConnection();
          connections.set(tabId, remoteConnection);
          console.log(`updated peer connections`, connections);
          remoteConnection.onicecandidate = (event) => {
            if (event.candidate) {
                port.postMessage(event.candidate.toJSON());
            }
          };

          remoteConnection.ondatachannel = (event) => {
            if (event.channel.label === 'initChannel') {
              console.log(`[${tabId}][ondatachannel] got init channel`);
              let initChannel = event.channel;
              initChannel.onopen = (event) => {
                console.log(`[${tabId}][initChannel] opened`);
              };
              initChannel.onclose = (event) => {
                console.log(`[${tabId}][initChannel] closed`);
              };
            } else if (event.channel.label === 'dataChannel') {
              let dataChannel = event.channel;
              let id = event.channel.id;
              console.log(`[${tabId}][ondatachannel] got data channel ${id}`);

              if (dataChannels.has(remoteConnection)) {
                dataChannels.get(remoteConnection).set(id, event.channel);
                console.log(`[${tabId}] updated data channels`, dataChannels.get(remoteConnection));
              } else {
                dataChannels.set(remoteConnection, new Map([[id, event.channel]]));
                console.log(`[${tabId}] updated data channels`, dataChannels.get(remoteConnection));
              }

              dataChannel.onopen = (event) => {
                console.log(`[${tabId}][dataChannel] opened data channel ${id}`);
                event.currentTarget.send('remoteOpened');
              };
              dataChannel.onclose = (event) => {
                  console.log(`[${tabId}][dataChannel] closed data channel ${id}`);
              };
              dataChannel.onerror = (event) => {
                console.error(`[${tabId}][dataChannel] error of data channel ${id}`, event);
              };
            }
          };

          await remoteConnection.setRemoteDescription(new RTCSessionDescription(msg));
          let answer = await remoteConnection.createAnswer();
          port.postMessage(answer.toJSON());
          await remoteConnection.setLocalDescription(answer);
        } else if (msg.candidate) {
          await remoteConnection.addIceCandidate(new RTCIceCandidate(msg));
        }
      } catch (err) {
        console.error(err.stack);
      }
    })();
  });

  port.onDisconnect.addListener(port => {
    console.log(`[${tabId}][signaling] disconnected`);
    if (connections.has(tabId)) {
      let connection = connections.get(tabId);
      connections.delete(tabId);
      console.info(`[${tabId}][deleted peer connection]`, connection);
      console.log(`updated peer connections`, connections);
    }
  });

  port.postMessage({status: 'connected'});
});

function convertHeader(headers) {
  let out = {}
  for (let key of headers.keys()) {
    out[key] = headers.get(key)
  }
  return out
}
function Object2Headers(headers) {
  let out = new Headers()
  for (let key of Object.keys(headers)) {
    out.set(key, headers[key])
  }
  return out
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'fetch') {
    let response
    let reader
    port.onDisconnect.addListener(() => {
      reader && reader.cancel()
    })
    port.onMessage.addListener(msg => {
      let chain = Promise.resolve()
      if (msg.method === 'fetch') {
        if (msg.args[1].headers != undefined)
          msg.args[1].headers = Object2Headers(msg.args[1].headers);
        chain = chain.then(() => fetch.apply(null, msg.args)).then(r => {
          response = r
          return {
            bodyUsed: r.bodyUsed,
            ok: r.ok,
            status: r.status,
            statusText: r.statusText,
            type: r.type,
            url: r.url,
            headers: convertHeader(r.headers)
          }
        })
      } else if (msg.method === 'json') {
        chain = chain.then(() => response.json())
      } else if (msg.method === 'stream') {
        reader = response.body.getReader();

        chain = chain.then(() => {
          let tabId = port.sender.tab.id;
          let channelId = msg.args[0];
          let dataChannel = dataChannels.get(connections.get(tabId)).get(channelId);

          dataChannel.onmessage = (event) => {
            // console.log(`[${tabId}][dataChannel] data channel ${channelId} received`, event.data);
            let channel = event.currentTarget;

            if (event.data === 'read') {
              reader.read().then(r => {
                if (r.done) {
                  channel.send('done');
                  dataChannels.get(connections.get(tabId)).delete(channelId);
                  console.log(`[${tabId}] updated data channels`, dataChannels.get(connections.get(tabId)));
                } else {
                  channel.send(r.value);
                }
              })
            } else if (event.data === 'cancel') {
              reader.cancel().then(() => {
                channel.send('canceled');
                dataChannels.get(connections.get(tabId)).delete(channelId);
                console.log(`[${tabId}] updated data channels`, dataChannels.get(connections.get(tabId)));
              });
            }
          };
        });
      } else if (msg.method === 'body.getReader') {
        chain = chain.then(() => {
          reader = response.body.getReader()
        })
      } else if (msg.method === 'reader.read') {
        chain = chain.then(() => reader.read()).then(r => {
          if (r.value != undefined)
            r.value = Array.from(r.value)
          return r
        })
      } else if (msg.method === 'reader.cancel') {
        chain = chain.then(() => reader.cancel())
      } else {
        port.disconnect()
        return
      }
      chain.then((...args) => {
        const outMsg = {
          method: msg.method,
          args: args
        }
        port.postMessage(outMsg)
      })
    })
  }
})

let playerCount = {};
let _t=function(s){return chrome.i18n.getMessage(s)}
chrome.runtime.onMessage.addListener((message, sender) => {
  let id = sender.tab.id;
  if (message.icon) {
    chrome.browserAction.enable(id);
    switch (message.state) {
      case 'playing':
        playerCount[id].playing++;
        break;
      case 'pending':
        playerCount[id].pending++;
        break;
      case 'pending-dec':
        playerCount[id].pending--;
        break;
    }
    let titleStr = [];
    if (playerCount[id].pending != 0)
      titleStr.push(playerCount[id].pending + _t('iconPending'));
    if (playerCount[id].playing != 0)
      titleStr.push(playerCount[id].playing + _t('iconPlaying'));
    chrome.browserAction.setTitle({ title: titleStr.join('\n'), tabId: id });
  }
})
chrome.tabs.onUpdated.addListener((id, changeInfo) => {
  if (changeInfo.status != 'loading')
    return;
  playerCount[id] = {
    playing: 0,
    pending: 0
  }
  chrome.browserAction.disable();
  chrome.browserAction.setTitle({ title: _t('iconIdle'), tabId: id });
});
chrome.tabs.onRemoved.addListener((id, removeInfo) => {
  delete playerCount[id];
})