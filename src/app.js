const express = require('express')
const app = express()
const https = require('httpolyglot')
const fs = require('fs')
const mediasoup = require('mediasoup')
const config = require('./config')
const path = require('path')
const Room = require('./Room')
const Peer = require('./Peer')

// SSL options
const options = {
  key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
  cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8')
}

//  create https server and socket server here
const httpsServer = https.createServer(options, app)
const {Server} = require('socket.io')
const io = new Server(httpsServer)
const connections = io.of('/mediasoup')

// pass the ui to express app 
app.use(express.static(path.join(__dirname, '..', 'public')))

// listinign on defined port 
httpsServer.listen(config.listenPort, () => {
  console.log('Listening on https://' + config.listenIp + ':' + config.listenPort)
})

// all mediasoup workers
let workers = []
let nextMediasoupWorkerIdx = 0
let roomList = new Map()

// call the create workers function
;(async () => {
  await createWorkers()
})()

// create workers according to machine cpu and exit the process if any error happend
async function createWorkers() {
  let { numWorkers } = config.mediasoup
  console.log("number",numWorkers);

  for (let i = 0; i < numWorkers; i++) {
    let worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    })

    worker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid)
      setTimeout(() => process.exit(1), 2000)
    })
    workers.push(worker)

    // log worker resource usage
    // setInterval(async () => {
    //         const usage = await worker.getResourceUsage();

    //         console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
    //     }, 120000);
  }
}

connections.on('connection', (socket) => {

  // socket for create room and add it to room list
  socket.on('createRoom', async ({ room_id }, callback) => {
    try{

      if (roomList.has(room_id)) {
        callback('already exists')
      } else {
        console.log('Created room', { room_id: room_id })
        let worker = await getMediasoupWorker()
        roomList.set(room_id, new Room(room_id, worker, io))
        callback(room_id)
      }
    }catch(e) {
      return e;
    }
  })

  // socket for adding a peer to provided room 
  socket.on('join', ({ room_id, name }, cb) => {
    try{
    console.log('User joined', {
      room_id: room_id,
      name: name
    })

    if (!roomList.has(room_id)) {
      return cb({
        error: 'Room does not exist'
      })
    }

    roomList.get(room_id).addPeer(new Peer(socket.id, name))
    socket.room_id = room_id

    cb(roomList.get(room_id).toJson())
  }catch(e){
    return e;
  }
  })

  // socket for listing all producers for newly joined users
  socket.on('getProducers', () => {
    try{

      if (!roomList.has(socket.room_id)) return
      console.log('Get producers', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })
  
      // send all the current producer to newly joined member
      let producerList = roomList.get(socket.room_id).getProducerListForPeer()
  
      socket.emit('newProducers', producerList)
    }catch(e){
      return e;
    }
  })

  // socket for returning getRouterRtpCapabilities
  socket.on('getRouterRtpCapabilities', (_, callback) => {
    
    try {
      console.log('Get RouterRtpCapabilities', {
        name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
      })
      callback(roomList.get(socket.room_id)?.getRtpCapabilities())
    } catch (e) {
       return  e.message
      
    }
  })

  // socket for allowing the peer to transport its data
  socket.on('createWebRtcTransport', async (_, callback) => {
    
    try {
      console.log('Create webrtc transport', {
        name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
      })
      const { params } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id)

      callback(params)
    } catch (err) {
      console.error(err)
      callback({
        error: err.message
      })
    }
  })

  socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
    try{

    
    console.log('Connect transport', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

    if (!roomList.has(socket.room_id)) return
    await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters)

    callback('success')
    }catch(e){
      return e;
    }
  })

  socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
   try{
    if (!roomList.has(socket.room_id)) {
      return callback({ error: 'not is a room' })
    }

    let producer_id = await roomList.get(socket.room_id).produce(socket.id, producerTransportId, rtpParameters, kind)

    console.log('Produce', {
      type: `${kind}`,
      name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
      id: `${producer_id}`
    })

    callback({
      producer_id
    })
  }catch(e){
    return e;
  }
  })
  let parts = []

  socket.on('record', async (data) => {
   try{
    parts.push(data)
    
  }catch(e){
    return e;
  }
  })
  socket.on('close-record', async () => {
   try{
     const blob = new Blob(parts, { type: 'video/webm' })
     console.log("close record -------------------------------1",parts );
     
    //  const inputFilePath = blob;
    // const outputFilePath = 'output.webm';
    // const command = ffmpeg()
    //   .input(inputFilePath)
    //   .output(outputFilePath)
    //   .on('end', () => {
    //     console.log("soped the recording");
    //   });
    // command.run();

     const stream = fs.createWriteStream("/sample.webm");
     stream.write(blob);
     stream.end();
  }catch(e){
    return e;
  }
  })

  socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
    //TODO null handling
    try{
    let params = await roomList.get(socket.room_id).consume(socket.id, consumerTransportId, producerId, rtpCapabilities)

    console.log('Consuming', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
      producer_id: `${producerId}`,
      consumer_id: `${params.id}`
    })

    callback(params)
  }catch(e){
    return e;
  }
  })

  socket.on('resume', async (data, callback) => {
    try{

      await consumer.resume()
      callback()
    }catch(e){
      return e;
    }
  })

  socket.on('getMyRoomInfo', (_, cb) => {
    try{
      cb(roomList.get(socket.room_id).toJson())
    }catch(e){
      return e;
    }
  })

  socket.on('disconnect', () => {
    try{
    console.log('Disconnect', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    if (!socket.room_id) return
    roomList.get(socket.room_id).removePeer(socket.id)
    }catch(e){
      return e;
    }
  })

  socket.on('producerClosed', ({ producer_id }) => {
    try{
    console.log('Producer close', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    roomList.get(socket.room_id).closeProducer(socket.id, producer_id)
  }catch(e){
    return e;
  }
  })

  socket.on('exitRoom', async (_, callback) => {
    try{

    
    console.log('Exit room', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    if (!roomList.has(socket.room_id)) {
      callback({
        error: 'not currently in a room'
      })
      return
    }
    // close transports
    await roomList.get(socket.room_id).removePeer(socket.id)
    if (roomList.get(socket.room_id).getPeers().size === 0) {
      roomList.delete(socket.room_id)
    }

    socket.room_id = null

    callback('successfully exited room')
  }catch(e){
    return e;
  }
  })
})

// TODO remove - never used?
function room() {
  return Object.values(roomList).map((r) => {
    return {
      router: r.router.id,
      peers: Object.values(r.peers).map((p) => {
        return {
          name: p.name
        }
      }),
      id: r.id
    }
  })
}
/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
  const worker = workers[nextMediasoupWorkerIdx]

  if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0

  return worker
}
