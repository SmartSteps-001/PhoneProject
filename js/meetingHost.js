// Import meeting tracking functionality
// Note: This assumes you have a way to get the current user ID in the frontend

// Function to track participants when meeting ends
async function trackMeetingEnd(participantCount) {
  try {
    const response = await fetch('/api/track-meeting-end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        participantCount: participantCount
      })
    });

    if (response.ok) {
      console.log('Meeting participants tracked successfully');
    }
  } catch (error) {
    console.error('Error tracking meeting end:', error);
  }
}

// Function to be called when participants join
function onParticipantCountChange(newCount) {
  // Update UI or perform other actions
  console.log(`Current participant count: ${newCount}`);
  
  // Store the count for when the meeting ends
  window.currentParticipantCount = newCount;
}

// Function to be called when meeting ends
function onMeetingEnd() {
  const finalCount = window.currentParticipantCount || 0;
  trackMeetingEnd(finalCount);
}

// Add event listeners for meeting lifecycle
window.addEventListener('beforeunload', () => {
  // Track participants when user leaves
  onMeetingEnd();
});

// Your existing meetingHost.js code would be here
// Make sure to call onParticipantCountChange() when participants join/leave
// Make sure to call onMeetingEnd() when the meeting officially ends

class EnhancedWebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.peerConnections = new Map();
    this.remoteStreams = new Map();
    this.pendingCandidates = new Map(); // FIX: Buffer for early ICE candidates
    this.makingOffer = new Map(); // FIX: Track negotiation state
    this.ignoreOffer = new Map(); // FIX: Prevent glare in negotiation
    this.isSettingRemoteDescription = new Map(); // FIX: Track async operations

    // Enhanced ICE configuration - will be updated from server
    this.configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };

    this.setupSocketListeners();
  }

  // FIX: Request and apply server ICE configuration
  async initialize() {
    try {
      // Get comprehensive ICE servers from backend
      const response = await fetch('/api/ice-servers');
      const { webrtcConfig } = await response.json();
      if (webrtcConfig) {
        this.configuration = webrtcConfig;
        console.log('Applied enhanced ICE configuration from server', this.configuration);
      }

      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      console.log('Local stream initialized with enhanced config');
      return true;
    } catch (error) {
      console.error('Error initializing WebRTC:', error);
      return false;
    }
  }

  setupSocketListeners() {
    // FIX: Handle offer with perfect negotiation pattern
    this.socket.on('offer', async (data) => {
      await this.handleOfferWithPerfectNegotiation(data);
    });

    this.socket.on('answer', async (data) => {
      await this.handleAnswerWithPerfectNegotiation(data);
    });

    // FIX: Buffer ICE candidates until ready
    this.socket.on('ice-candidate', async (data) => {
      await this.handleIceCandidateWithBuffering(data);
    });

    // FIX: Handle connection restart requests
    this.socket.on('retry-connection', async (data) => {
      await this.handleConnectionRetry(data);
    });

    this.socket.on('restart-connection', async (data) => {
      await this.restartConnection(data);
    });

    this.socket.on('initiate-connection', async (data) => {
      await this.createPeerConnection(data.targetSocketId, data.shouldCreateOffer, data.webrtcConfig);
    });
  }

  // FIX: Create peer connection with enhanced monitoring and recovery
  async createPeerConnection(remoteSocketId, shouldCreateOffer, serverConfig = null) {
    try {
      console.log(`Creating peer connection with ${remoteSocketId}, shouldCreateOffer: ${shouldCreateOffer}`);

      // Close existing connection if present
      if (this.peerConnections.has(remoteSocketId)) {
        this.peerConnections.get(remoteSocketId).close();
        this.peerConnections.delete(remoteSocketId);
      }

      // Use server config if provided, otherwise use stored config
      const config = serverConfig || this.configuration;
      const peerConnection = new RTCPeerConnection(config);
      this.peerConnections.set(remoteSocketId, peerConnection);

      // Initialize state tracking for perfect negotiation
      this.makingOffer.set(remoteSocketId, false);
      this.ignoreOffer.set(remoteSocketId, false);
      this.isSettingRemoteDescription.set(remoteSocketId, false);
      this.pendingCandidates.set(remoteSocketId, []);

      // Add local tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          const sender = peerConnection.addTrack(track, this.localStream);
          console.log(`Added ${track.kind} track to peer connection`);
        });
      }

      // FIX: Enhanced ICE candidate handling with immediate transmission
      peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          console.log(`Sending ICE candidate (${candidate.type || 'unknown'}) to ${remoteSocketId}`);
          this.socket.emit('ice-candidate', {
            target: remoteSocketId,
            candidate: candidate.toJSON(),
            connectionId: `${this.socket.id}-${remoteSocketId}`
          });
        } else {
          console.log(`ICE gathering complete for ${remoteSocketId}`);
        }
      };

      // FIX: Handle ICE gathering state for diagnostics
      peerConnection.onicegatheringstatechange = () => {
        console.log(`ICE gathering state for ${remoteSocketId}: ${peerConnection.iceGatheringState}`);
      };

      // FIX: Enhanced connection state monitoring with automatic recovery
      peerConnection.onconnectionstatechange = async () => {
        const state = peerConnection.connectionState;
        console.log(`Connection state with ${remoteSocketId}: ${state}`);

        this.socket.emit('connection-state-change', {
          targetSocketId: remoteSocketId,
          state: state,
          connectionId: `${this.socket.id}-${remoteSocketId}`
        });

        if (state === 'failed') {
          console.warn(`Connection failed with ${remoteSocketId}, initiating ICE restart`);
          await this.performIceRestart(remoteSocketId);
        } else if (state === 'disconnected') {
          console.warn(`Connection disconnected with ${remoteSocketId}, waiting before restart...`);
          // Wait a bit before restarting (connection might recover)
          setTimeout(async () => {
            if (peerConnection.connectionState === 'disconnected') {
              await this.performIceRestart(remoteSocketId);
            }
          }, 3000);
        } else if (state === 'connected') {
          console.log(`Successfully connected to ${remoteSocketId}`);
          // Process any buffered candidates
          await this.processBufferedCandidates(remoteSocketId);
        }
      };

      // FIX: Monitor ICE connection state separately
      peerConnection.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with ${remoteSocketId}: ${peerConnection.iceConnectionState}`);

        if (peerConnection.iceConnectionState === 'failed') {
          console.error(`ICE connection failed with ${remoteSocketId}`);
          this.socket.emit('connection-failed', {
            targetSocketId: remoteSocketId,
            reason: 'ice-failed',
            connectionId: `${this.socket.id}-${remoteSocketId}`
          });
        }
      };

      // Handle incoming tracks
      peerConnection.ontrack = (event) => {
        console.log(`Received ${event.track.kind} track from ${remoteSocketId}`);
        const [remoteStream] = event.streams;
        this.remoteStreams.set(remoteSocketId, remoteStream);
        this.updateRemoteVideo(remoteSocketId, remoteStream);

        // Monitor track status
        event.track.onended = () => {
          console.log(`Track ended from ${remoteSocketId}: ${event.track.kind}`);
        };

        event.track.onmute = () => {
          console.log(`Track muted from ${remoteSocketId}: ${event.track.kind}`);
        };

        event.track.onunmute = () => {
          console.log(`Track unmuted from ${remoteSocketId}: ${event.track.kind}`);
        };
      };

      // FIX: Perfect negotiation pattern - handle negotiation needed
      peerConnection.onnegotiationneeded = async () => {
        try {
          console.log(`Negotiation needed with ${remoteSocketId}`);
          this.makingOffer.set(remoteSocketId, true);

          await peerConnection.setLocalDescription();

          this.socket.emit('offer', {
            target: remoteSocketId,
            offer: peerConnection.localDescription.toJSON(),
            connectionId: `${this.socket.id}-${remoteSocketId}`
          });

          console.log(`Sent offer to ${remoteSocketId}`);
        } catch (error) {
          console.error(`Error in negotiationneeded for ${remoteSocketId}:`, error);
        } finally {
          this.makingOffer.set(remoteSocketId, false);
        }
      };

      // Create initial offer if designated
      if (shouldCreateOffer) {
        try {
          console.log(`Creating initial offer for ${remoteSocketId}`);
          this.makingOffer.set(remoteSocketId, true);

          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            iceRestart: false
          });

          await peerConnection.setLocalDescription(offer);

          this.socket.emit('offer', {
            target: remoteSocketId,
            offer: peerConnection.localDescription.toJSON(),
            connectionId: `${this.socket.id}-${remoteSocketId}`
          });

          console.log(`Initial offer sent to ${remoteSocketId}`);
        } catch (error) {
          console.error(`Error creating initial offer for ${remoteSocketId}:`, error);
        } finally {
          this.makingOffer.set(remoteSocketId, false);
        }
      }

    } catch (error) {
      console.error('Error creating peer connection:', error);
    }
  }

  // FIX: Perfect negotiation pattern for handling offers
  async handleOfferWithPerfectNegotiation(data) {
    const { offer, sender } = data;
    console.log(`Handling offer from ${sender}`);

    try {
      let peerConnection = this.peerConnections.get(sender);

      if (!peerConnection) {
        // Create connection if it doesn't exist
        await this.createPeerConnection(sender, false);
        peerConnection = this.peerConnections.get(sender);
      }

      // Perfect negotiation: determine if we should ignore this offer
      const offerCollision = offer.type === 'offer' &&
        (this.makingOffer.get(sender) || peerConnection.signalingState !== 'stable');

      this.ignoreOffer.set(sender, offerCollision && this.isPolite(sender));

      if (this.ignoreOffer.get(sender)) {
        console.log(`Ignoring offer from ${sender} due to collision (polite party)`);
        return;
      }

      this.isSettingRemoteDescription.set(sender, true);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      this.isSettingRemoteDescription.set(sender, false);

      // Process any buffered candidates now that remote description is set
      await this.processBufferedCandidates(sender);

      // Create and send answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      this.socket.emit('answer', {
        target: sender,
        answer: peerConnection.localDescription.toJSON(),
        connectionId: `${this.socket.id}-${sender}`
      });

      console.log(`Sent answer to ${sender}`);
    } catch (error) {
      console.error(`Error handling offer from ${sender}:`, error);
      this.isSettingRemoteDescription.set(sender, false);
    }
  }

  // FIX: Perfect negotiation pattern for handling answers
  async handleAnswerWithPerfectNegotiation(data) {
    const { answer, sender } = data;
    console.log(`Handling answer from ${sender}`);

    try {
      const peerConnection = this.peerConnections.get(sender);

      if (!peerConnection) {
        console.warn(`No peer connection found for answer from ${sender}`);
        return;
      }

      this.isSettingRemoteDescription.set(sender, true);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      this.isSettingRemoteDescription.set(sender, false);

      // Process buffered candidates
      await this.processBufferedCandidates(sender);

      console.log(`Answer from ${sender} applied successfully`);
    } catch (error) {
      console.error(`Error handling answer from ${sender}:`, error);
      this.isSettingRemoteDescription.set(sender, false);
    }
  }

  // FIX: Buffer ICE candidates until remote description is set
  async handleIceCandidateWithBuffering(data) {
    const { candidate, sender } = data;
    const peerConnection = this.peerConnections.get(sender);

    if (!peerConnection) {
      console.warn(`No peer connection for ICE candidate from ${sender}, ignoring`);
      return;
    }

    try {
      // Check if we can add the candidate immediately
      if (peerConnection.remoteDescription && !this.isSettingRemoteDescription.get(sender)) {
        if (candidate && candidate.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`Added ICE candidate from ${sender}`);
        }
      } else {
        // Buffer the candidate for later
        if (!this.pendingCandidates.has(sender)) {
          this.pendingCandidates.set(sender, []);
        }
        this.pendingCandidates.get(sender).push(candidate);
        console.log(`Buffered ICE candidate from ${sender} (total buffered: ${this.pendingCandidates.get(sender).length})`);
      }
    } catch (error) {
      console.error(`Error handling ICE candidate from ${sender}:`, error);
    }
  }

  // FIX: Process buffered ICE candidates once remote description is set
  async processBufferedCandidates(remoteSocketId) {
    const candidates = this.pendingCandidates.get(remoteSocketId);
    if (!candidates || candidates.length === 0) {
      return;
    }

    console.log(`Processing ${candidates.length} buffered ICE candidates for ${remoteSocketId}`);
    const peerConnection = this.peerConnections.get(remoteSocketId);

    if (!peerConnection || !peerConnection.remoteDescription) {
      console.warn(`Cannot process buffered candidates for ${remoteSocketId}: not ready`);
      return;
    }

    const processed = [];
    for (const candidate of candidates) {
      try {
        if (candidate && candidate.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          processed.push(candidate);
        }
      } catch (error) {
        console.error(`Error adding buffered candidate for ${remoteSocketId}:`, error);
      }
    }

    // Remove processed candidates
    this.pendingCandidates.set(
      remoteSocketId,
      candidates.filter(c => !processed.includes(c))
    );

    console.log(`Processed ${processed.length} buffered candidates for ${remoteSocketId}`);
  }

  // FIX: Perform ICE restart with proper renegotiation
  async performIceRestart(remoteSocketId) {
    console.log(`Performing ICE restart for ${remoteSocketId}`);
    const peerConnection = this.peerConnections.get(remoteSocketId);

    if (!peerConnection) {
      console.warn(`No peer connection to restart for ${remoteSocketId}`);
      return;
    }

    try {
      this.makingOffer.set(remoteSocketId, true);

      // Create offer with ICE restart
      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);

      this.socket.emit('offer', {
        target: remoteSocketId,
        offer: peerConnection.localDescription.toJSON(),
        connectionId: `ice-restart-${this.socket.id}-${remoteSocketId}`,
        iceRestart: true
      });

      console.log(`ICE restart offer sent to ${remoteSocketId}`);
    } catch (error) {
      console.error(`Error during ICE restart for ${remoteSocketId}:`, error);
    } finally {
      this.makingOffer.set(remoteSocketId, false);
    }
  }

  // FIX: Handle connection retry from server
  async handleConnectionRetry(data) {
    const { targetSocketId, attempt } = data;
    console.log(`Retry connection request for ${targetSocketId}, attempt ${attempt}`);

    // Wait a bit, then try to reconnect
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.createPeerConnection(targetSocketId, true);
  }

  // FIX: Handle restart connection command from server
  async restartConnection(data) {
    const { targetSocketId, webrtcConfig } = data;
    console.log(`Restarting connection with ${targetSocketId}`);

    const oldConnection = this.peerConnections.get(targetSocketId);
    if (oldConnection) {
      oldConnection.close();
    }

    this.peerConnections.delete(targetSocketId);
    this.pendingCandidates.delete(targetSocketId);

    await this.createPeerConnection(targetSocketId, true, webrtcConfig);
  }

  // Determine if we're the "polite" peer (for perfect negotiation)
  isPolite(remoteSocketId) {
    // Simple: compare socket IDs lexicographically
    return this.socket.id < remoteSocketId;
  }

  updateRemoteVideo(socketId, stream) {
    // Delegate to the meeting instance
    setTimeout(() => {
      const videoWrapper = document.querySelector(`[data-socket-id="${socketId}"]`);
      if (videoWrapper) {
        const video = videoWrapper.querySelector('.video-frame');
        if (video && video.srcObject !== stream) {
          video.srcObject = stream;
          video.play().catch(e => console.error('Error playing video:', e));
          console.log(`Video attached and playing for ${socketId}`);
        }
      }
    }, 100);
  }

  setReady() {
    this.socket.emit('participant-ready');
  }

  getRemoteStream(socketId) {
    return this.remoteStreams.get(socketId);
  }

  removePeerConnection(socketId) {
    const peerConnection = this.peerConnections.get(socketId);
    if (peerConnection) {
      peerConnection.close();
      this.peerConnections.delete(socketId);
    }
    this.remoteStreams.delete(socketId);
    this.pendingCandidates.delete(socketId);
    this.makingOffer.delete(socketId);
    this.ignoreOffer.delete(socketId);
    this.isSettingRemoteDescription.delete(socketId);
  }

  async toggleAudio(enabled) {
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = enabled;
      }
    }
  }

  async toggleVideo(enabled) {
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = enabled;
      }
    }
  }
}


class HostMeeting {
  
 constructor() {
        this.socket = io();
        window.socket = this.socket;
        this.meetingId = window.location.pathname.split('/').pop();
        this.userName = '';
        this.userId = null;
        this.isHost = true;
        this.participants = new Map();
        this.currentView = 'sidebar';
        this.spotlightedParticipant = null;
        this.webrtc = new EnhancedWebRTCManager(this.socket);
        this.participantsPanelOpen = false;
        this.searchTerm = '';
        this.reactionManager = null;
        this.currentGridSet = 0;
        this.maxParticipantsPerSet = 15;
        this.currentSidebarSet = 0;
        this.maxSidebarParticipants = 5;
        this.meetingStartTime = null;
        this.meetingName = '';
        this.shouldAutoStartScreenShare = false;
        this.shouldAutoStopVideo = false; // Add this flag
        
        this.meetingPermissions = {
            chatEnabled: true,
            fileSharing: true,
            emojiReactions: true
        };
        
        this.init().then(() => {
            window.hostMeetingInstance = this;
            window.myName = this.userName;
            console.log('Host meeting initialized. Host name:', window.myName);
        });
    }

    async init() {
        await this.getUserName();
        this.checkAutoStopVideoFlag(); // Add this line
        this.checkAutoScreenShareFlag();
        this.setupSocketListeners();
        this.setupEventListeners();
        this.setupPermissionControls();
        this.updateTime();
        
        // Get meeting name from URL parameters or use default
        const urlParams = new URLSearchParams(window.location.search);
        const urlMeetingName = urlParams.get('name');
        
        if (urlMeetingName) {
            this.meetingName = urlMeetingName.trim();
            console.log('Using URL meeting name:', this.meetingName);
        } else {
            this.meetingName = `${this.userName}'s Meeting`;
            console.log('Using default meeting name:', this.meetingName);
        }
        
        // Set meeting start time
        this.meetingStartTime = new Date();
        
        // Update meeting title if element exists
        const meetingTitleEl = document.querySelector('.meeting-title, #meetingTitle');
        if (meetingTitleEl) {
            meetingTitleEl.textContent = this.meetingName;
        }
        
        // Join meeting with custom name
        this.joinMeeting();
        this.showMeetingInfo();
        
        // Initialize WebRTC and show local video immediately
        const initialized = await this.webrtc.initialize();
        if (initialized) {
            this.showLocalVideo();
            // Set ready after a short delay to ensure everything is set up
            setTimeout(async () => {
                this.webrtc.setReady();
                
                // Auto start screen share if flag is set
                if (this.shouldAutoStartScreenShare) {
                    await this.autoStartScreenShare();
                }
                
                // Auto stop video if flag is set (from create form)
                if (this.shouldAutoStopVideo) {
                    await this.autoStopVideo();
                }
            }, 1000);
        }

        // Initialize Reaction Manager
        this.reactionManager = new ReactionManager(this.socket);
    }
        checkAutoStopVideoFlag() {
        // Check if this meeting was created from the form
        const autoStopVideo = sessionStorage.getItem('autoStopVideo');
        const fromCreateForm = sessionStorage.getItem('fromCreateForm');
        
        if (autoStopVideo === 'true' && fromCreateForm === 'true') {
            this.shouldAutoStopVideo = true;
            console.log('Auto stop video flag detected');
            
            // Clear the flags after reading them
            sessionStorage.removeItem('autoStopVideo');
            sessionStorage.removeItem('fromCreateForm');
        }
    }
      async autoStopVideo() {
        try {
            console.log('Auto stopping video...');
            
            // Use the existing stopVideo function
            if (typeof window.stopVideo === 'function') {
                const success = window.stopVideo();
                if (success) {
                    console.log('Video auto-stopped successfully');
                    this.showToast('Video stopped automatically', 'info');
                } else {
                    console.log('Failed to auto-stop video');
                }
            } else {
                // Fallback: manually stop video if function not available
                await this.manualStopVideo();
            }
            
        } catch (error) {
            console.error('Failed to auto stop video:', error);
        }
    }
        async manualStopVideo() {
        try {
            // 1. Disable the video track in the local stream
            if (this.webrtc.localStream) {
                const videoTrack = this.webrtc.localStream.getVideoTracks()[0];
                if (videoTrack) {
                    videoTrack.enabled = false;
                    console.log('Local video track disabled via manual method');
                }
            }

            // 2. Update the camera button state to reflect video is off
            const cameraBtn = document.getElementById('cameraBtn');
            if (cameraBtn) {
                cameraBtn.setAttribute('data-active', 'true'); // true means camera is "off"
                const icon = cameraBtn.querySelector('i');
                if (icon) {
                    icon.className = 'fas fa-video-slash';
                }
            }

            // 3. Update participant state locally
            const localParticipant = this.participants.get(this.socket.id);
            if (localParticipant) {
                localParticipant.isCameraOff = true;
            }

            // 4. Notify the server about camera state change
            this.socket.emit('toggle-camera', { isCameraOff: true });

            // 5. Update the local video display to show it's off
            const localVideoWrapper = document.querySelector(`[data-socket-id="${this.socket.id}"]`);
            if (localVideoWrapper) {
                let cameraOffIndicator = localVideoWrapper.querySelector('.camera-off-indicator');
                if (!cameraOffIndicator) {
                    cameraOffIndicator = document.createElement('div');
                    cameraOffIndicator.className = 'camera-off-indicator';
                    cameraOffIndicator.innerHTML = '<i class="fas fa-video-slash"></i>';
                    cameraOffIndicator.style.cssText = `
                        position: absolute;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        color: white;
                        font-size: 24px;
                        z-index: 10;
                    `;
                    localVideoWrapper.appendChild(cameraOffIndicator);
                }
            }

            console.log('Video stopped successfully via manual method');
            return true;

        } catch (error) {
            console.error('Error in manual stop video:', error);
            return false;
        }
    }
       checkAutoScreenShareFlag() {
        const urlParams = new URLSearchParams(window.location.search);
        this.shouldAutoStartScreenShare = urlParams.get('autoScreenShare') === 'true';
        console.log('Auto screen share flag:', this.shouldAutoStartScreenShare);
    }
     async autoStartScreenShare() {
        try {
            console.log('Auto starting screen share...');
            
            // Start screen sharing
            await this.webrtc.startScreenShare();
            
            // Update the screen share button state
            const screenShareBtn = document.getElementById('screenShareBtn');
            if (screenShareBtn) {
                screenShareBtn.setAttribute('data-active', 'true');
                const icon = screenShareBtn.querySelector('i');
                if (icon) {
                    icon.className = 'fas fa-stop';
                }
            }
            
            // Emit screen share started event
            this.socket.emit('start-screen-share', { 
                streamId: 'screen',
                hasComputerAudio: true 
            });
            
            this.showToast('Screen sharing started automatically', 'success');
            console.log('Auto screen share started successfully');
            
        } catch (error) {
            console.error('Failed to auto start screen share:', error);
            this.showToast('Failed to start screen sharing automatically. You can start it manually.', 'warning');
            
            // Reset the flag since auto start failed
            this.shouldAutoStartScreenShare = false;
        }
    }
    



  showLocalVideo() {
    // Create local video immediately
    this.participants.set(this.socket.id, {
      socketId: this.socket.id,
      name: this.userName,
      isHost: true,
      isCoHost: false,
      isMuted: false,
      isCameraOff: false,
      isSpotlighted: true, // Host is spotlighted by default
      isScreenSharing: false,
      handRaised: false
    });
    this.spotlightedParticipant = this.socket.id;
    this.renderParticipants();
    this.renderParticipantsList();
  }

  async getUserName() {
    try {
      const response = await fetch('/api/user');
      const data = await response.json();
      if (data.user) {
        this.userName = data.user.name;
        this.userId = data.user.id;
        window.currentUserId = this.userId; // Set for stats tracking
      } else {
        window.location.href = '/login';
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
      window.location.href = '/login';
    }
  }

  setupSocketListeners() {
  this.socket.on('joined-meeting', (data) => {
            console.log('Joined meeting as host:', data);
            this.updateParticipants(data.participants);
            if (data.permissions) {
                this.meetingPermissions = data.permissions;
                this.updatePermissionControls();
            }
            this.updateMeetingTitle();
            this.updateRaisedHands(data.raisedHands);
            
            // Notify about meeting start
            this.socket.emit('meeting-started', {
                meetingId: this.meetingId,
                meetingName: this.meetingName,
                userId: this.userId
            });
        });


    this.socket.on('participant-joined', (data) => {
      console.log('Participant joined:', data);
      this.updateParticipants(data.participants);
      this.showToast(`${data.participant.name} joined the meeting`);
    });

    this.socket.on('participant-left', (data) => {
      console.log('Participant left:', data);
      this.removeParticipantVideo(data.socketId);
      this.updateParticipants(data.participants);
      this.showToast(`${data.participantName} left the meeting`);
      
      // Clean up WebRTC connection
      this.webrtc.removePeerConnection(data.socketId);
    });

    this.socket.on('participant-spotlighted', (data) => {
      console.log('Participant spotlighted:', data);
      this.handleSpotlightChange(data.spotlightedParticipant);
      this.updateParticipants(data.participants);
    });

    this.socket.on('spotlight-removed', (data) => {
      console.log('Spotlight removed:', data);
      this.handleSpotlightRemoved();
      this.updateParticipants(data.participants);
    });

    this.socket.on('participant-muted', (data) => {
      console.log('Participant muted:', data);
      this.updateParticipantAudio(data.targetSocketId, data.isMuted);
      this.updateParticipants(data.participants);
    });

    this.socket.on('cohost-assigned', (data) => {
      console.log('Co-host assigned:', data);
      this.updateParticipants(data.participants);
      this.showToast('Co-host assigned successfully');
    });

    this.socket.on('participant-kicked', (data) => {
      console.log('Participant kicked:', data);
      this.removeParticipantVideo(data.targetSocketId);
      this.updateParticipants(data.participants);
      this.showToast('Participant removed from meeting');
    });

    this.socket.on('action-error', (data) => {
      console.error('Action error:', data);
      this.showToast(data.message, 'error');
    });

    // Hand raised events
    this.socket.on('hand-raised', (data) => {
      this.updateRaisedHands(data.raisedHands);
      if (this.reactionManager) {
        this.reactionManager.updateHandRaised(data.socketId, data.participantName, true);
      }
    });

    this.socket.on('hand-lowered', (data) => {
      this.updateRaisedHands(data.raisedHands);
      if (this.reactionManager) {
        this.reactionManager.updateHandRaised(data.socketId, data.participantName, false);
      }
    });

    this.socket.on('meeting-name-updated', (data) => {
    console.log('Meeting name updated by host:', data);
    this.meetingName = data.newName;
    this.updateMeetingTitle();
    this.showToast(`Meeting renamed to "${data.newName}"`);
});

    // Permission update confirmation
    this.socket.on('meeting-permissions-updated', (data) => {
      console.log('Meeting permissions updated:', data);
      this.meetingPermissions = data.permissions;
      this.showToast(`Meeting permissions updated by ${data.changedBy}`);
    });
  }

  setupEventListeners() {
    // Participants panel toggle
    document.getElementById('memberToggleBtn').addEventListener('click', () => {
      this.toggleParticipantsPanel();
    });

    document.getElementById('closeParticipants').addEventListener('click', () => {
      this.closeParticipantsPanel();
    });

    // Search functionality
    document.getElementById('participantSearch').addEventListener('input', (e) => {
      this.searchTerm = e.target.value.toLowerCase();
      this.renderParticipantsList();
    });

    // View toggle
    document.getElementById('viewToggle').addEventListener('click', () => {
      this.toggleView();
    });

    // Grid navigation
    document.getElementById('prevSetBtn').addEventListener('click', () => {
      this.navigateGridSet(-1);
    });

    document.getElementById('nextSetBtn').addEventListener('click', () => {
      this.navigateGridSet(1);
    });

    // Sidebar navigation
    document.getElementById('prevSidebarBtn').addEventListener('click', () => {
      this.navigateSidebarSet(-1);
    });

    document.getElementById('nextSidebarBtn').addEventListener('click', () => {
      this.navigateSidebarSet(1);
    });

    // Mic toggle
    document.getElementById('micBtn').addEventListener('click', (e) => {
      this.toggleMic(e.currentTarget);
    });

    // Camera toggle
    document.getElementById('cameraBtn').addEventListener('click', (e) => {
      this.toggleCamera(e.currentTarget);
    });

    // Screen share toggle
    document.getElementById('screenShareBtn').addEventListener('click', (e) => {
      this.toggleScreenShare(e.currentTarget);
    });

    // End call
    document.getElementById('endCallBtn').addEventListener('click', () => {
      this.endMeeting();
    });

    // Meeting info modal
    document.getElementById('meetingTitle').addEventListener('click', () => {
      this.showMeetingInfo();
    });

    document.getElementById('closeMeetingInfo').addEventListener('click', () => {
      this.hideMeetingInfo();
    });

    document.getElementById('copyMeetingId').addEventListener('click', () => {
      this.copyToClipboard(this.meetingId);
    });

    document.getElementById('copyJoinUrl').addEventListener('click', () => {
      const joinUrl = `${window.location.origin}/join/${this.meetingId}`;
      this.copyToClipboard(joinUrl);
    });

    // Close participants panel when clicking outside
    document.addEventListener('click', (e) => {
      if (this.participantsPanelOpen && 
          !document.getElementById('participantsPanel').contains(e.target) &&
          !document.getElementById('memberToggleBtn').contains(e.target)) {
        this.closeParticipantsPanel();
      }
    });
  }

  setupPermissionControls() {
    // Chat enable/disable toggle
    const chatToggle = document.querySelector('#chat input[type="checkbox"]:first-of-type');
    if (chatToggle) {
      chatToggle.addEventListener('change', (e) => {
        this.updatePermission('chatEnabled', e.target.checked);
      });
    }

    // File sharing toggle
    const fileToggle = document.querySelector('#chat .setting-item:nth-child(3) input[type="checkbox"]');
    if (fileToggle) {
      fileToggle.addEventListener('change', (e) => {
        this.updatePermission('fileSharing', e.target.checked);
      });
    }

    // Emoji reactions toggle
    const emojiToggle = document.querySelector('#chat .setting-item:nth-child(4) input[type="checkbox"]');
    if (emojiToggle) {
      emojiToggle.addEventListener('change', (e) => {
        this.updatePermission('emojiReactions', e.target.checked);
      });
    }
  }

  updatePermission(permissionType, enabled) {
    this.meetingPermissions[permissionType] = enabled;
    
    // Send permission update to server
    this.socket.emit('update-meeting-permissions', {
      permissions: this.meetingPermissions
    });

    // Show feedback to host
    const permissionNames = {
      chatEnabled: 'Chat',
      fileSharing: 'File Sharing',
      emojiReactions: 'Emoji Reactions'
    };
    
    this.showToast(
      `${permissionNames[permissionType]} ${enabled ? 'enabled' : 'disabled'} for all participants`
    );
  }

  updatePermissionControls() {
    // Update chat toggle
    const chatToggle = document.querySelector('#chat input[type="checkbox"]:first-of-type');
    if (chatToggle) {
      chatToggle.checked = this.meetingPermissions.chatEnabled;
    }

    // Update file sharing toggle
    const fileToggle = document.querySelector('#chat .setting-item:nth-child(3) input[type="checkbox"]');
    if (fileToggle) {
      fileToggle.checked = this.meetingPermissions.fileSharing;
    }

    // Update emoji reactions toggle
    const emojiToggle = document.querySelector('#chat .setting-item:nth-child(4) input[type="checkbox"]');
    if (emojiToggle) {
      emojiToggle.checked = this.meetingPermissions.emojiReactions;
    }
  }

  updateRaisedHands(raisedHands) {
    if (this.reactionManager) {
      this.reactionManager.raisedHands.clear();
      raisedHands.forEach(socketId => {
        this.reactionManager.raisedHands.add(socketId);
      });
      this.reactionManager.updateParticipantsDisplay();
    }
  }

  toggleParticipantsPanel() {
    if (this.participantsPanelOpen) {
      this.closeParticipantsPanel();
    } else {
      this.openParticipantsPanel();
    }
  }

  openParticipantsPanel() {
    this.participantsPanelOpen = true;
    document.getElementById('participantsPanel').classList.add('open');
    document.getElementById('videoContainer').classList.add('participants-open');
    this.renderParticipantsList();
    const chatBar = document.getElementById("chatBar");
    chatBar.classList.remove("open");
  }

  openChatsPanel() {
    this.participantsPanelOpen = true;
    document.getElementById('videoContainer').classList.add('participants-open');
  }

  closeChatsPanel() {
    this.participantsPanelOpen = false;
    document.getElementById('videoContainer').classList.remove('participants-open');
  }

  closeParticipantsPanel() {
    this.participantsPanelOpen = false;
    document.getElementById('participantsPanel').classList.remove('open');
    document.getElementById('videoContainer').classList.remove('participants-open');
  }

  renderParticipantsList() {
    const participantsList = document.getElementById('participantsList');
    const participantsPanelCount = document.getElementById('participantsPanelCount');
    
    participantsList.innerHTML = '';
    
    const filteredParticipants = Array.from(this.participants.values()).filter(participant => 
      participant.name.toLowerCase().includes(this.searchTerm)
    );

    participantsPanelCount.textContent = filteredParticipants.length;

    filteredParticipants.forEach(participant => {
      const participantItem = this.createParticipantItem(participant);
      participantsList.appendChild(participantItem);
    });

    // Update reaction manager if available
    if (this.reactionManager) {
      this.reactionManager.onParticipantsUpdated();
    }
  }

  createParticipantItem(participant) {
    const item = document.createElement('div');
    item.className = 'participant-item';
    item.dataset.socketId = participant.socketId;

    const initials = participant.name.split(' ').map(n => n[0]).join('').toUpperCase();
    
    let roleText = 'Participant';
    let roleClass = 'participant';
    if (participant.isHost) {
      roleText = 'Host';
      roleClass = 'host';
    } else if (participant.isCoHost) {
      roleText = 'Co-Host';
      roleClass = 'cohost';
    }

    const statusIcons = [];
    if (participant.isMuted) {
      statusIcons.push('<div class="status-icon muted"><i class="fas fa-microphone-slash"></i></div>');
    }
    if (participant.isCameraOff) {
      statusIcons.push('<div class="status-icon camera-off"><i class="fas fa-video-slash"></i></div>');
    }

    const dropdownOptions = this.getParticipantDropdownOptions(participant);

    item.innerHTML = `
      <div class="participant-avatar">${initials}</div>
      <div class="participant-info">
        <div class="participant-name-section">${participant.name}</div>
        <div class="participant-role">
          <span class="role-badge ${roleClass}">${roleText}</span>
          ${participant.isSpotlighted ? '<i class="fas fa-star" style="color: #fbbf24; margin-left: 4px;"></i>' : ''}
        </div>
      </div>
      <div class="participant-status">
        ${statusIcons.join('')}
      </div>
      <div class="participant-actions">
        <button class="participant-menu-btn" data-participant-id="${participant.socketId}">
          <i class="fas fa-ellipsis-v"></i>
        </button>
        <div class="participant-dropdown" id="dropdown-${participant.socketId}">
          ${dropdownOptions}
        </div>
      </div>
    `;

    // Bind events
    const menuBtn = item.querySelector('.participant-menu-btn');
    const dropdown = item.querySelector('.participant-dropdown');

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close all other dropdowns
      document.querySelectorAll('.participant-dropdown').forEach(d => {
        if (d !== dropdown) d.classList.remove('show');
      });
      dropdown.classList.toggle('show');
    });

    // Bind dropdown actions
    const dropdownButtons = dropdown.querySelectorAll('button');
    dropdownButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = button.dataset.action;
        this.handleParticipantAction(action, participant.socketId);
        dropdown.classList.remove('show');
      });
    });

    return item;
  }

  getParticipantDropdownOptions(participant) {
    let options = [];
    
    if (participant.isSpotlighted) {
      options.push('<button data-action="remove-spotlight"><i class="fas fa-star-half-alt"></i> Remove Spotlight</button>');
    } else {
      options.push('<button data-action="spotlight"><i class="fas fa-star"></i> Spotlight</button>');
    }
    
    if (!participant.isHost) {
      options.push(`<button data-action="mute"><i class="fas fa-microphone-slash"></i> ${participant.isMuted ? 'Unmute' : 'Mute'}</button>`);
      
      if (!participant.isCoHost) {
        options.push('<button data-action="make-cohost"><i class="fas fa-user-shield"></i> Make Co-Host</button>');
        options.push('<button data-action="kick" class="danger"><i class="fas fa-user-times"></i> Remove</button>');
      }
    }
    
    return options.join('');
  }
  joinMeeting() {
    this.socket.emit('join-as-host', {
      meetingId: this.meetingId,
      hostName: this.userName,


    });
  }

  updateParticipants(participants) {
    // Keep local participant if not in server list
    const localParticipant = this.participants.get(this.socket.id);
    
    this.participants.clear();
    participants.forEach(p => {
      this.participants.set(p.socketId, p);
    });

    // Ensure local participant is always present
    if (localParticipant && !this.participants.has(this.socket.id)) {
      this.participants.set(this.socket.id, localParticipant);
    }

    this.renderParticipants();
    this.updateParticipantCount();
    if (this.participantsPanelOpen) {
      this.renderParticipantsList();
    }
  }

  renderParticipants() {
    const mainVideoSection = document.getElementById('mainVideoSection');
    const secondaryVideosSection = document.getElementById('secondaryVideosSection');
    
    // Clear existing videos
    mainVideoSection.innerHTML = '';
    secondaryVideosSection.innerHTML = '';

    const participantArray = Array.from(this.participants.values());
    
    if (this.currentView === 'grid') {
      // Calculate which participants to show in current set
      const startIndex = this.currentGridSet * this.maxParticipantsPerSet;
      const endIndex = Math.min(startIndex + this.maxParticipantsPerSet, participantArray.length);
      const currentSetParticipants = participantArray.slice(startIndex, endIndex);
      
      this.renderGridLayout(currentSetParticipants, secondaryVideosSection);
      
      this.updateGridNavigation();
    } else {
      // Sidebar view logic
      const sidebarParticipants = participantArray.filter(p => !p.isSpotlighted || this.currentView !== 'sidebar');
      
      // Calculate which participants to show in current sidebar set
      const startIndex = this.currentSidebarSet * this.maxSidebarParticipants;
      const endIndex = Math.min(startIndex + this.maxSidebarParticipants, sidebarParticipants.length);
      const currentSetSidebarParticipants = sidebarParticipants.slice(startIndex, endIndex);
      
      participantArray.forEach((participant, index) => {
        const videoWrapper = this.createVideoWrapper(participant);
        
        if (participant.isSpotlighted && this.currentView === 'sidebar') {
          videoWrapper.classList.add('main-video');
          videoWrapper.setAttribute('data-main-video', 'true');
          mainVideoSection.appendChild(videoWrapper);
        } else if (currentSetSidebarParticipants.includes(participant)) {
          secondaryVideosSection.appendChild(videoWrapper);
        }
      });
      
      this.updateSidebarNavigation();
    }
  }

  renderGridLayout(participants, container) {
    const participantCount = participants.length;
    
    // Custom layouts for specific participant counts
    if (participantCount === 12 || participantCount === 13 || participantCount === 14 || participantCount === 11 || participantCount === 2 || participantCount === 7 || participantCount === 8 || participantCount === 9 || (participantCount >= 3 && participantCount <= 6)) {
      container.className = 'secondary-videos-section custom-layout';
      container.classList.add(`participants-${participantCount}`);
      this.renderCustomGridLayout(participants, container, participantCount);
    } else {
      // Standard grid layout for 1-2 or 8+ participants
      container.className = 'secondary-videos-section standard-grid';
      this.renderStandardGridLayout(participants, container, participantCount);
    }
  }

  renderCustomGridLayout(participants, container, count) {
    let rows = [];
    
    switch (count) {
      case 2:
        // 2 participants side by side, filling the screen
        participants.forEach(participant => {
          const videoWrapper = this.createVideoWrapper(participant);
          container.appendChild(videoWrapper);
        });
        return; // Exit early for 2 participants
        
      case 3:
        // 2 in first row, 1 in second row
        rows = [
          participants.slice(0, 2),
          participants.slice(2, 3)
        ];
        break;
      case 4:
        // 2 in first row, 2 in second row
        rows = [
          participants.slice(0, 2),
          participants.slice(2, 4)
        ];
        break;
      case 5:
        // 3 in first row, 2 in second row
        rows = [
          participants.slice(0, 3),
          participants.slice(3, 5)
        ];
        break;
      case 6:
        // 3 in each of the 2 rows
        rows = [
          participants.slice(0, 3),
          participants.slice(3, 6)
        ];
        break;
      case 7:
    // 4 in first row, 3 in second row
    rows = [
      participants.slice(0, 4), // first 4
      participants.slice(4, 7)  // next 3
    ];
    break;

        
      case 8:
        // 4 in first row, 4 in second row
        rows = [
          participants.slice(0, 4),
          participants.slice(4, 8)
        ];
        break;
        
     case 9:
    // 5 in first row, 4 in second row
    rows = [
      participants.slice(0, 5), // first 5
      participants.slice(5, 9)  // next 4
    ];
    break;

      case 11:
        rows = [
          participants.slice(0, 4),
          participants.slice(4, 8),
          participants.slice(8, 11)
        ];
        break;
      case 12:
        rows = [
          participants.slice(0, 4),
          participants.slice(4, 8),
          participants.slice(8, 12)
        ];
        break;
      case 13:
        // 5 in first row, 5 in second row, 3 in third row
        rows = [
          participants.slice(0, 5),
          participants.slice(5, 10),
          participants.slice(10, 13)
        ];
        break;
      case 14:
        rows = [
          participants.slice(0, 5),
          participants.slice(5, 10),
          participants.slice(10, 14)
        ];
        break;
    }
    
    rows.forEach(rowParticipants => {
      const rowDiv = document.createElement('div');
      rowDiv.className = 'grid-row';
    
      
      rowParticipants.forEach(participant => {
        const videoWrapper = this.createVideoWrapper(participant);
        rowDiv.appendChild(videoWrapper);
      });
      
      container.appendChild(rowDiv);
    });
  }

  renderStandardGridLayout(participants, container, count) {
    // Adjust grid columns based on participant count
    let columns = 5;
    let maxWidth = '280px';
    
    if (count === 1) {
      columns = 1;
      maxWidth = '400px';
    } else if (count === 2) {
      columns = 2;
      maxWidth = '350px';
    } else if (count <= 5) {
      columns = count;
      maxWidth = '320px';
    } else if (count <= 10) {
      columns = 5;
      maxWidth = '280px';
    } else if (count <= 15) {
      columns = 5;
      maxWidth = '250px';
    } else if (count <= 20) {
      columns = 5;
      maxWidth = '220px';
    } else {
      columns = 5;
      maxWidth = '200px';
    }
    
    container.style.gridTemplateColumns = `repeat(${columns}, minmax(180px, ${maxWidth}))`;
    container.style.gap = count > 20 ? '12px' : '16px';
    
    participants.forEach(participant => {
      const videoWrapper = this.createVideoWrapper(participant);
      container.appendChild(videoWrapper);
    });
  }
    
  createVideoWrapper(participant) {
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.dataset.socketId = participant.socketId;
    
    if (participant.isSpotlighted) {
      wrapper.setAttribute('data-main-video', 'true');
    }

    const dropdownOptions = this.getDropdownOptions(participant);
    
    wrapper.innerHTML = `
      <video class="video-frame" autoplay playsinline ${participant.socketId === this.socket.id ? 'muted' : ''}></video>
      <div class="video-controls">
        <button class="menu-dots">⋮</button>
        <div class="dropdown-menu">
          ${dropdownOptions}
        </div>
      </div>
      <div class="participant-name">${participant.name}${participant.isHost ? ' (Host)' : ''}${participant.isCoHost ? ' (Co-Host)' : ''}</div>
      ${participant.isSpotlighted ? '<div class="spotlight-badge"><i class="fas fa-star"></i></div>' : ''}
      ${participant.isMuted ? '<div class="audio-indicator"><i class="fas fa-microphone-slash"></i></div>' : ''}
    `;

    this.bindVideoWrapperEvents(wrapper, participant);
    
    // Attach video stream
    setTimeout(() => {
      const video = wrapper.querySelector('.video-frame');
      if (participant.socketId === this.socket.id) {
        // Local video
        if (this.webrtc.isScreenSharing && this.webrtc.screenStream) {
          video.srcObject = this.webrtc.screenStream;
        } else if (this.webrtc.localStream) {
          video.srcObject = this.webrtc.localStream;
        }
        video.play().catch(e => console.error('Error playing local video:', e));
      } else {
        // Remote video
        const remoteStream = this.webrtc.getRemoteStream(participant.socketId);
        if (remoteStream) {
          video.srcObject = remoteStream;
          video.play().catch(e => console.error('Error playing remote video:', e));
        }
      }
    }, 100);
    
    return wrapper;
  }

  getDropdownOptions(participant) {
    let options = [];
    
    if (participant.isSpotlighted) {
      options.push('<button data-action="remove-spotlight">Remove Spotlight</button>');
    } else {
      options.push('<button data-action="spotlight">Spotlight</button>');
    }
    
    if (!participant.isHost) {
      options.push(`<button data-action="mute">${participant.isMuted ? 'Unmute' : 'Mute'} Participant</button>`);
      
      if (!participant.isCoHost) {
        options.push('<button data-action="make-cohost">Make Co-Host</button>');
        options.push('<button data-action="kick">Remove from Meeting</button>');
      }
    }
    
    return options.join('');
  }

  bindVideoWrapperEvents(wrapper, participant) {
    // Double click to spotlight
    wrapper.addEventListener('dblclick', () => {
      if (!participant.isSpotlighted) {
        this.spotlightParticipant(participant.socketId);
      }
    });

    // Dropdown menu actions
    const dropdownButtons = wrapper.querySelectorAll('.dropdown-menu button');
    dropdownButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = button.dataset.action;
        this.handleParticipantAction(action, participant.socketId);
      });
    });
  }

  handleParticipantAction(action, socketId) {
    switch(action) {
      case 'spotlight':
        this.spotlightParticipant(socketId);
        break;
      case 'remove-spotlight':
        this.removeSpotlight();
        break;
      case 'mute':
        this.muteParticipant(socketId);
        break;
      case 'make-cohost':
        this.makeCoHost(socketId);
        break;
      case 'kick':
        this.kickParticipant(socketId);
        break;
    }
  }

  spotlightParticipant(socketId) {
    this.socket.emit('spotlight-participant', { targetSocketId: socketId });
  }

  removeSpotlight() {
    this.socket.emit('remove-spotlight');
  }

  muteParticipant(socketId) {
    this.socket.emit('mute-participant', { targetSocketId: socketId });
  }

  makeCoHost(socketId) {
    this.socket.emit('make-cohost', { targetSocketId: socketId });
  }

  kickParticipant(socketId) {
    const participant = this.participants.get(socketId);
    if (participant && confirm(`Remove ${participant.name} from the meeting?`)) {
      this.socket.emit('kick-participant', { targetSocketId: socketId });
    }
  }

  handleSpotlightChange(spotlightedSocketId) {
    this.spotlightedParticipant = spotlightedSocketId;
    this.renderParticipants();
    if (this.participantsPanelOpen) {
      this.renderParticipantsList();
    }
  }

  handleSpotlightRemoved() {
    this.spotlightedParticipant = null;
    this.renderParticipants();
    if (this.participantsPanelOpen) {
      this.renderParticipantsList();
    }
  }

  removeParticipantVideo(socketId) {
    const wrapper = document.querySelector(`[data-socket-id="${socketId}"]`);
    if (wrapper) {
      wrapper.style.transition = 'all 0.3s ease';
      wrapper.style.opacity = '0';
      wrapper.style.transform = 'scale(0.8)';
      setTimeout(() => wrapper.remove(), 300);
    }
  }

  updateParticipantAudio(socketId, isMuted) {
    const wrapper = document.querySelector(`[data-socket-id="${socketId}"]`);
    if (wrapper) {
      let audioIndicator = wrapper.querySelector('.audio-indicator');
      if (isMuted && !audioIndicator) {
        audioIndicator = document.createElement('div');
        audioIndicator.className = 'audio-indicator';
        audioIndicator.innerHTML = '<i class="fas fa-microphone-slash"></i>';
        wrapper.appendChild(audioIndicator);
      } else if (!isMuted && audioIndicator) {
        audioIndicator.remove();
      }
    }
  }

  toggleView() {
    const videoContainer = document.getElementById('videoContainer');
    const viewToggleIcon = document.getElementById('viewToggleIcon');
    const viewToggleText = document.getElementById('viewToggleText');
    
    if (this.currentView === 'sidebar') {
      this.currentView = 'grid';
      this.currentGridSet = 0; // Reset to first set when switching to grid
      this.currentSidebarSet = 0; // Reset sidebar set as well
      videoContainer.classList.remove('sidebar-view');
      videoContainer.classList.add('grid-view');
      viewToggleIcon.className = 'fas fa-columns';
      viewToggleText.textContent = 'Sidebar View';
    } else {
      this.currentView = 'sidebar';
      this.currentSidebarSet = 0; // Reset to first set when switching to sidebar
      videoContainer.classList.remove('grid-view');
      videoContainer.classList.add('sidebar-view');
      viewToggleIcon.className = 'fas fa-th';
      viewToggleText.textContent = 'Grid View';
    }
    
    this.renderParticipants();
  }

  navigateGridSet(direction) {
    const totalParticipants = this.participants.size;
    const totalSets = Math.ceil(totalParticipants / this.maxParticipantsPerSet);
    
    this.currentGridSet += direction;
    
    if (this.currentGridSet < 0) {
      this.currentGridSet = 0;
    } else if (this.currentGridSet >= totalSets) {
      this.currentGridSet = totalSets - 1;
    }
    
    this.renderParticipants();
    this.updateGridNavigation();
  }

  navigateSidebarSet(direction) {
    const participantArray = Array.from(this.participants.values());
    const sidebarParticipants = participantArray.filter(p => !p.isSpotlighted || this.currentView !== 'sidebar');
    const totalSets = Math.ceil(sidebarParticipants.length / this.maxSidebarParticipants);
    
    this.currentSidebarSet += direction;
    
    if (this.currentSidebarSet < 0) {
      this.currentSidebarSet = 0;
    } else if (this.currentSidebarSet >= totalSets) {
      this.currentSidebarSet = totalSets - 1;
    }
    
    this.renderParticipants();
  }

  updateSidebarNavigation() {
    const participantArray = Array.from(this.participants.values());
    const sidebarParticipants = participantArray.filter(p => !p.isSpotlighted || this.currentView !== 'sidebar');
    const totalSets = Math.ceil(sidebarParticipants.length / this.maxSidebarParticipants);
    const sidebarNavigation = document.getElementById('sidebarNavigation');
    const prevBtn = document.getElementById('prevSidebarBtn');
    const nextBtn = document.getElementById('nextSidebarBtn');
    const currentSidebarInfo = document.getElementById('currentSidebarInfo');
    
    if (this.currentView === 'sidebar' && totalSets > 1) {
      sidebarNavigation.style.display = 'flex';
      prevBtn.disabled = this.currentSidebarSet === 0;
      nextBtn.disabled = this.currentSidebarSet === totalSets - 1;
      currentSidebarInfo.textContent = `${this.currentSidebarSet + 1} of ${totalSets}`;
    } else {
      sidebarNavigation.style.display = 'none';
    }
  }

  updateGridNavigation() {
    const totalParticipants = this.participants.size;
    const totalSets = Math.ceil(totalParticipants / this.maxParticipantsPerSet);
    const gridNavigation = document.getElementById('gridNavigation');
    const prevBtn = document.getElementById('prevSetBtn');
    const nextBtn = document.getElementById('nextSetBtn');
    const currentSetInfo = document.getElementById('currentSetInfo');
    
    if (this.currentView === 'grid' && totalSets > 1) {
      gridNavigation.style.display = 'flex';
      prevBtn.disabled = this.currentGridSet === 0;
      nextBtn.disabled = this.currentGridSet === totalSets - 1;
      currentSetInfo.textContent = `Set ${this.currentGridSet + 1} of ${totalSets}`;
    } else {
      gridNavigation.style.display = 'none';
    }
  }

  async toggleMic(button) {
    const isActive = button.getAttribute('data-active') === 'true';
    button.setAttribute('data-active', !isActive);
    
    const icon = button.querySelector('i');
    icon.className = isActive ? 'fas fa-microphone-slash' : 'fas fa-microphone';
    
    await this.webrtc.toggleAudio(!isActive);
    this.socket.emit('toggle-mic', { isMuted: isActive });
  }

  async toggleCamera(button) {
    const isActive = button.getAttribute('data-active') === 'true';
    button.setAttribute('data-active', !isActive);
    
    const icon = button.querySelector('i');
    icon.className = isActive ? 'fas fa-video-slash' : 'fas fa-video';
    
    await this.webrtc.toggleVideo(!isActive);
    this.socket.emit('toggle-camera', { isCameraOff: isActive });
  }

    async toggleScreenShare(button) {
        const isActive = button.getAttribute('data-active') === 'true';
        
        if (isActive) {
            await this.webrtc.stopScreenShare();
            button.setAttribute('data-active', 'false');
            const icon = button.querySelector('i');
            if (icon) {
                icon.className = 'fas fa-desktop';
            }
            this.socket.emit('stop-screen-share');
            this.showToast('Screen sharing stopped', 'info');
        } else {
            try {
                await this.webrtc.startScreenShare();
                button.setAttribute('data-active', 'true');
                const icon = button.querySelector('i');
                if (icon) {
                    icon.className = 'fas fa-stop';
                }
                this.socket.emit('start-screen-share', { 
                    streamId: 'screen',
                    hasComputerAudio: true 
                });
                this.showToast('Screen sharing started', 'success');
            } catch (error) {
                console.error('Failed to start screen share:', error);
                this.showToast('Failed to start screen sharing', 'error');
            }
        }
    }


  updateParticipantCount() {
    const count = this.participants.size;
    document.getElementById('participantCount').textContent = count;
  }
updateMeetingName(newName) {
    const trimmedName = newName.trim();
    if (!trimmedName) return;
    
    this.meetingName = trimmedName;
    console.log('Meeting name updated to:', this.meetingName);
    
    // Update the UI immediately
    const meetingTitleEl = document.querySelector('.meeting-title, #meetingTitle');
    if (meetingTitleEl) {
        meetingTitleEl.textContent = this.meetingName;
    }
    
    // CRITICAL: Notify server about name change so it updates socket.meetingData
    this.socket.emit('meeting-name-changed', {
        meetingId: this.meetingId,
        newName: this.meetingName,
        userId: this.userId
    });
    
    // Show confirmation to user
    this.showToast('Meeting renamed successfully', 'success');
}

updateMeetingTitle() {
    const meetingTitleEl = document.getElementById('meetingTitle');
    if (meetingTitleEl) {
        meetingTitleEl.textContent = this.meetingName;
    }
}
enableMeetingNameEdit() {
    const meetingTitleEl = document.getElementById('meetingTitle');
    if (!meetingTitleEl) return;
    
    // Make it editable
    meetingTitleEl.contentEditable = true;
    meetingTitleEl.style.cursor = 'text';
    meetingTitleEl.style.padding = '4px 8px';
    meetingTitleEl.style.border = '1px dashed #ccc';
    
    // Add event listeners
    meetingTitleEl.addEventListener('blur', () => {
        const newName = meetingTitleEl.textContent.trim();
        if (newName && newName !== this.meetingName) {
            this.updateMeetingName(newName);
        }
        
        // Remove edit styling
        meetingTitleEl.contentEditable = false;
        meetingTitleEl.style.cursor = 'pointer';
        meetingTitleEl.style.border = 'none';
    });
    
    meetingTitleEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            meetingTitleEl.blur(); // Trigger the blur event
        }
        if (e.key === 'Escape') {
            meetingTitleEl.textContent = this.meetingName; // Reset to original
            meetingTitleEl.blur();
        }
    });
    
    // Select all text for easy editing
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(meetingTitleEl);
    selection.removeAllRanges();
    selection.addRange(range);
}

  updateTime() {
    const timeElement = document.getElementById('meetingTime');
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
    timeElement.textContent = timeString;
    
    setTimeout(() => this.updateTime(), 60000);
  }

showMeetingInfo() {
    // Update meeting name from current UI state before showing
    this.updateMeetingTitle();
    
    document.getElementById('displayMeetingId').textContent = this.meetingId;
    document.getElementById('displayJoinUrl').textContent = `${window.location.origin}/join/${this.meetingId}`;
    
    // Add current meeting name to the modal (if there's a field for it)
    const meetingNameDisplay = document.getElementById('displayMeetingName');
    if (meetingNameDisplay) {
        meetingNameDisplay.textContent = this.meetingName;
    }
    
    document.getElementById('meetingInfoModal').style.display = 'flex';
}
syncMeetingNameFromUI() {
    const meetingTitleEl = document.querySelector('.meeting-title, #meetingTitle');
    if (meetingTitleEl) {
        const displayedName = meetingTitleEl.textContent.trim();
        if (displayedName && displayedName !== this.meetingName) {
            console.log('Auto-syncing meeting name from UI:', displayedName);
            this.meetingName = displayedName;
        }
    }
}

  hideMeetingInfo() {
    document.getElementById('meetingInfoModal').style.display = 'none';
  }

  copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      this.showToast('Copied to clipboard!');
    }).catch(() => {
      this.showToast('Failed to copy', 'error');
    });
  }

  showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'error' : type === 'info' ? 'info' : ''}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

endMeeting() {
    if (confirm('Are you sure you want to end the meeting for everyone?')) {
        // IMPORTANT: Get the absolute final meeting name from UI
        const currentMeetingTitleEl = document.querySelector('.meeting-title, #meetingTitle');
        const finalMeetingName = currentMeetingTitleEl ? 
            currentMeetingTitleEl.textContent.trim() : 
            this.meetingName;
        
        // Update our stored meeting name to match final UI state
        if (finalMeetingName && finalMeetingName !== this.meetingName) {
            this.meetingName = finalMeetingName;
            console.log('Final meeting name synchronized:', this.meetingName);
        }
        
        console.log('Ending meeting with final name:', this.meetingName);
        
        // Send meeting end event with the final name
        if (this.socket && this.meetingId && this.userId) {
            this.socket.emit('meeting-ended', {
                meetingId: this.meetingId,
                meetingName: this.meetingName, // Final name
                userId: this.userId,
                startTime: this.meetingStartTime,
                endTime: new Date()
            });
        }
        
        // End the meeting for all participants
        this.socket.emit('end-meeting');
        
        // Navigate away after a short delay to ensure the event is sent
        setTimeout(() => {
            window.location.href = '/dashboard';
        }, 500);
    }
}

}

// Safe video play function with proper error handling
async function safeVideoPlay(videoElement, socketId = 'unknown') {
  if (!videoElement || !videoElement.srcObject) {
    console.warn(`Cannot play video for ${socketId}: no video element or source`);
    return false;
  }
  
  // Check if video element is still in the document
  if (!document.contains(videoElement)) {
    console.warn(`Cannot play video for ${socketId}: video element not in document`);
    return false;
  }
  
  try {
    // Cancel any pending play requests
    if (videoElement.readyState >= 2) { // HAVE_CURRENT_DATA or higher
      await videoElement.play();
      console.log(`Video playing successfully for ${socketId}`);
      return true;
    } else {
      // Wait for video to be ready
      return new Promise((resolve) => {
        const onCanPlay = async () => {
          videoElement.removeEventListener('canplay', onCanPlay);
          videoElement.removeEventListener('error', onError);
          
          if (document.contains(videoElement)) {
            try {
              await videoElement.play();
              console.log(`Video playing successfully for ${socketId} after waiting`);
              resolve(true);
            } catch (error) {
              console.error(`Error playing video for ${socketId} after waiting:`, error);
              resolve(false);
            }
          } else {
            console.warn(`Video element removed for ${socketId} while waiting`);
            resolve(false);
          }
        };
        
        const onError = () => {
          videoElement.removeEventListener('canplay', onCanPlay);
          videoElement.removeEventListener('error', onError);
          console.error(`Video error while waiting for ${socketId}`);
          resolve(false);
        };
        
        videoElement.addEventListener('canplay', onCanPlay);
        videoElement.addEventListener('error', onError);
        
        // Timeout after 5 seconds
        setTimeout(() => {
          videoElement.removeEventListener('canplay', onCanPlay);
          videoElement.removeEventListener('error', onError);
          console.warn(`Video play timeout for ${socketId}`);
          resolve(false);
        }, 5000);
      });
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`Video play aborted for ${socketId} - this is normal during cleanup`);
    } else if (error.name === 'NotAllowedError') {
      console.warn(`Video autoplay blocked for ${socketId} - user interaction required`);
    } else {
      console.error(`Error playing video for ${socketId}:`, error);
    }
    return false;
  }
}

// Safe video cleanup function
function safeVideoCleanup(videoElement, socketId = 'unknown') {
  if (!videoElement) return;
  
  try {
    // Pause the video first
    if (!videoElement.paused) {
      videoElement.pause();
    }
    
    // Clear the source
    if (videoElement.srcObject) {
      const tracks = videoElement.srcObject.getTracks();
      tracks.forEach(track => track.stop());
      videoElement.srcObject = null;
    }
    
    // Remove from DOM if still present
    if (videoElement.parentNode) {
      videoElement.parentNode.removeChild(videoElement);
    }
    
    console.log(`Video cleanup completed for ${socketId}`);
  } catch (error) {
    console.error(`Error during video cleanup for ${socketId}:`, error);
  }
}

// Enhanced cleanup function for host
function cleanupAllResources() {
  console.log('Host cleaning up all resources...');
  
  // Clean up local video
  const localVideo = document.getElementById('localVideo');
  if (localVideo) {
    safeVideoCleanup(localVideo, 'local');
  }
  
  // Stop local stream
  if (window.hostMeetingInstance && window.hostMeetingInstance.webrtc.localStream) {
    window.hostMeetingInstance.webrtc.localStream.getTracks().forEach(track => track.stop());
    window.hostMeetingInstance.webrtc.localStream = null;
  }
  
  // Close all peer connections
  if (window.hostMeetingInstance && window.hostMeetingInstance.webrtc.peerConnections) {
    window.hostMeetingInstance.webrtc.peerConnections.forEach((pc, socketId) => {
      try {
        pc.close();
      } catch (error) {
        console.error(`Error closing peer connection for ${socketId}:`, error);
      }
    });
    window.hostMeetingInstance.webrtc.peerConnections.clear();
  }
  
  // Disconnect socket
  if (window.hostMeetingInstance && window.hostMeetingInstance.socket && window.hostMeetingInstance.socket.connected) {
    window.hostMeetingInstance.socket.disconnect();
  }
}

// Enhanced notification system for host
function showNotification(message, type = 'info', duration = 5000) {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  
  // Add styles
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    border-radius: 8px;
    color: white;
    font-weight: 500;
    z-index: 10000;
    max-width: 300px;
    word-wrap: break-word;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    transition: all 0.3s ease;
  `;
  
  // Set background color based on type
  switch (type) {
    case 'success':
      notification.style.backgroundColor = '#10b981';
      break;
    case 'error':
      notification.style.backgroundColor = '#ef4444';
      break;
    case 'warning':
      notification.style.backgroundColor = '#f59e0b';
      break;
    default:
      notification.style.backgroundColor = '#3b82f6';
  }
  
  document.body.appendChild(notification);
  
  // Auto remove after duration
  setTimeout(() => {
    if (notification.parentNode) {
      notification.style.opacity = '0';
      notification.style.transform = 'translateX(100%)';
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }
  }, duration);
}

// Add cleanup event listeners for host
window.addEventListener('beforeunload', cleanupAllResources);
window.addEventListener('unload', cleanupAllResources);

// Add visibility change handler for host
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Page is hidden, pause all videos to save resources
    document.querySelectorAll('.video-frame').forEach(video => {
      if (!video.paused) {
        video.pause();
      }
    });
  } else {
    // Page is visible, resume videos
    document.querySelectorAll('.video-frame').forEach(async (video) => {
      if (video.paused && video.srcObject) {
        await safeVideoPlay(video, 'resumed');
      }
    });
  }
});

// Close dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.participant-dropdown').forEach(dropdown => {
    dropdown.classList.remove('show');
  });
});

// Initialize the host meeting
document.addEventListener('DOMContentLoaded', () => {
  new HostMeeting();
});

// Make host name globally accessible
var myName = null;
window.myName = null;

// Store global reference when meeting initializes  
window.addEventListener('load', function() {
  setTimeout(() => {
    // Try to find the host name from various sources
    const participantItems = document.querySelectorAll('.participant-item');
    for (let item of participantItems) {
      const roleElement = item.querySelector('.role-badge');
      if (roleElement && roleElement.textContent.includes('Host')) {
        const nameElement = item.querySelector('.participant-name');
        if (nameElement) {
          myName = nameElement.textContent.trim();
          window.myName = myName;
          console.log('Host name found:', myName);
          break;
        }
      }
    }
    
    // Fallback to hostMeetingInstance if available
    if (!myName && window.hostMeetingInstance) {
      myName = window.hostMeetingInstance.userName;
      window.myName = myName;
      console.log('Host name from instance:', myName);
    }
  }, 3000); // Wait 3 seconds for everything to load
});

// Set overflow properties for secondary videos section
const section = document.getElementById('secondaryVideosSection');
if (section) {
  section.style.overflowX = 'hidden';
  section.style.overflowY = 'hidden';
}
// Function to immediately and temporarily shut off video
function stopVideo() {
    // Get the host meeting instance
    const hostInstance = window.hostMeetingInstance;
    
    if (!hostInstance) {
        console.error('Host meeting instance not found');
        return false;
    }

    try {
        // 1. Disable the video track in the local stream
        if (hostInstance.webrtc.localStream) {
            const videoTrack = hostInstance.webrtc.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = false;
                console.log('Local video track disabled');
            }
        }

        // 2. Update the camera button state to reflect video is off
        const cameraBtn = document.getElementById('cameraBtn');
        if (cameraBtn) {
            cameraBtn.setAttribute('data-active', 'true'); // true means camera is "off"
            const icon = cameraBtn.querySelector('i');
            if (icon) {
                icon.className = 'fas fa-video-slash';
            }
        }

        // 3. Update participant state locally
        const localParticipant = hostInstance.participants.get(hostInstance.socket.id);
        if (localParticipant) {
            localParticipant.isCameraOff = true;
        }

        // 4. Notify the server about camera state change
        hostInstance.socket.emit('toggle-camera', { isCameraOff: true });

        // 5. Update the local video display to show it's off
        const localVideoWrapper = document.querySelector(`[data-socket-id="${hostInstance.socket.id}"]`);
        if (localVideoWrapper) {
            let cameraOffIndicator = localVideoWrapper.querySelector('.camera-off-indicator');
            if (!cameraOffIndicator) {
                cameraOffIndicator = document.createElement('div');
                cameraOffIndicator.className = 'camera-off-indicator';
                cameraOffIndicator.innerHTML = '<i class="fas fa-video-slash"></i>';
                cameraOffIndicator.style.cssText = `
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    color: white;
                    font-size: 24px;
                    z-index: 10;
                `;
                localVideoWrapper.appendChild(cameraOffIndicator);
            }
        }

        // 6. Show feedback to user
        if (hostInstance.showToast) {
            hostInstance.showToast('Video stopped', 'info');
        }

        console.log('Video stopped successfully');
        return true;

    } catch (error) {
        console.error('Error stopping video:', error);
        
        // Show error feedback
        if (hostInstance.showToast) {
            hostInstance.showToast('Failed to stop video', 'error');
        }
        
        return false;
    }
}

// Function to restart video (companion function)
function startVideo() {
    const hostInstance = window.hostMeetingInstance;
    
    if (!hostInstance) {
        console.error('Host meeting instance not found');
        return false;
    }

    try {
        // 1. Enable the video track in the local stream
        if (hostInstance.webrtc.localStream) {
            const videoTrack = hostInstance.webrtc.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = true;
                console.log('Local video track enabled');
            }
        }

        // 2. Update the camera button state
        const cameraBtn = document.getElementById('cameraBtn');
        if (cameraBtn) {
            cameraBtn.setAttribute('data-active', 'false');
            const icon = cameraBtn.querySelector('i');
            if (icon) {
                icon.className = 'fas fa-video';
            }
        }

        // 3. Update participant state locally
        const localParticipant = hostInstance.participants.get(hostInstance.socket.id);
        if (localParticipant) {
            localParticipant.isCameraOff = false;
        }

        // 4. Notify the server
        hostInstance.socket.emit('toggle-camera', { isCameraOff: false });

        // 5. Remove camera off indicator
        const localVideoWrapper = document.querySelector(`[data-socket-id="${hostInstance.socket.id}"]`);
        if (localVideoWrapper) {
            const cameraOffIndicator = localVideoWrapper.querySelector('.camera-off-indicator');
            if (cameraOffIndicator) {
                cameraOffIndicator.remove();
            }
        }

        // 6. Show feedback
        if (hostInstance.showToast) {
            hostInstance.showToast('Video started', 'success');
        }

        console.log('Video started successfully');
        return true;

    } catch (error) {
        console.error('Error starting video:', error);
        
        if (hostInstance.showToast) {
            hostInstance.showToast('Failed to start video', 'error');
        }
        
        return false;
    }
}

// Function to toggle video (uses existing logic but ensures immediate effect)
function toggleVideo() {
    const hostInstance = window.hostMeetingInstance;
    
    if (!hostInstance) {
        console.error('Host meeting instance not found');
        return false;
    }

    const cameraBtn = document.getElementById('cameraBtn');
    const isCurrentlyOff = cameraBtn?.getAttribute('data-active') === 'true';
    
    if (isCurrentlyOff) {
        return startVideo();
    } else {
        return stopVideo();
    }
}

// Make functions globally available
window.stopVideo = stopVideo;
window.startVideo = startVideo;
window.toggleVideo = toggleVideo;
  