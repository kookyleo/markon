import { CONFIG } from '../core/config.js';
import { getXPath, getElementByXPath, Logger } from '../core/utils.js';

export class CollaborationManager {
    constructor(app) {
        this.app = app;
        this.isBroadcasting = false;
        this.isFollowing = true;
        this.clientId = this._getOrCreateClientId();
        this.hostname = window.__MARKON_HOSTNAME__ || 'Guest';
        this.userColor = this._loadSavedColor();
        this.activeLeader = null;
        this.leaderTimer = null;
        
        this.container = null;
        this.sphere = null;
        this.panel = null;

        // Dragging state
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.sphereX = 0;
        this.sphereY = 0;

        // Visual feedback state
        this.rippleTimeout = null;
    }

    init() {
        if (!this.app.ws) return;

        this._createUI();
        this._setupEventListeners();

        // Listen for live actions
        this.app.ws.on(CONFIG.WS_MESSAGE_TYPES.LIVE_ACTION, (msg) => {
            this.handleLiveAction(msg.data);
        });

        Logger.log('Live', `Initialized as ${this.hostname} (${this.clientId})`);
    }

    handleLiveAction(data) {
        if (data.clientId === this.clientId) return;
        if (!this.isFollowing) return;

        // Visual feedback: Update leader info
        this.activeLeader = data;
        this._updateUIState();

        // Clear leader status after 3 seconds of inactivity
        if (this.leaderTimer) clearTimeout(this.leaderTimer);
        this.leaderTimer = setTimeout(() => {
            this.activeLeader = null;
            this._updateUIState();
        }, 3000);

        if (data.action === 'scroll_to') {
            this._scrollToTarget(data);
        }
    }

    _scrollToTarget(data) {
        const el = getElementByXPath(data.xpath);
        if (!el) return;

        const rect = el.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        
        // Target: position the element in viewport
        const targetY = window.scrollY + rect.top - (viewportHeight * 0.3); // 30% from top
        
        window.scrollTo({
            top: targetY,
            behavior: 'smooth'
        });

        this._showVisualGuide(el, data.color);
    }

    _showVisualGuide(element, color) {
        const existing = document.querySelector('.markon-live-ripple');
        if (existing) existing.remove();
        
        const ripple = document.createElement('div');
        ripple.className = 'markon-live-ripple';
        ripple.style.borderColor = color;
        ripple.style.boxShadow = `0 0 20px ${color}`;
        
        const rect = element.getBoundingClientRect();
        ripple.style.top = `${window.scrollY + rect.top + rect.height / 2}px`;
        ripple.style.left = `${window.scrollX + rect.left + rect.width / 2}px`;
        
        document.body.appendChild(ripple);
        setTimeout(() => ripple.remove(), CONFIG.COLLABORATION.RIPPLE_DURATION);
    }

    broadcastAction(action, extraData = {}) {
        if (!this.isBroadcasting || !this.app.ws) return;

        // Implementation for determining focus element
        // For now, let's say we broadcast the element at the center of screen
        const target = this._getCenterElement();
        if (!target) return;

        const xpath = getXPath(target);
        this.app.ws.send({
            type: CONFIG.WS_MESSAGE_TYPES.LIVE_ACTION,
            data: {
                clientId: this.clientId,
                name: this.hostname,
                color: this.userColor,
                action: action,
                xpath: xpath,
                ...extraData
            }
        });
    }

    _getCenterElement() {
        const x = window.innerWidth / 2;
        const y = window.innerHeight * 0.3;
        const el = document.elementFromPoint(x, y);
        
        // Find nearest block or heading
        let current = el;
        while (current && current !== document.body) {
            if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'PRE', 'BLOCKQUOTE'].includes(current.tagName)) {
                return current;
            }
            current = current.parentElement;
        }
        return el;
    }

    _createUI() {
        const html = `
            <div id="markon-live-container" class="markon-live-container">
                <div id="markon-live-sphere" class="markon-live-sphere" style="background-color: ${this.userColor}">
                    <span class="initial">${this.hostname.charAt(0).toUpperCase()}</span>
                    <div class="leader-info"></div>
                </div>
                <div id="markon-live-panel" class="markon-live-panel">
                    <div class="panel-header">Markon Live</div>
                    <div class="panel-row">
                        <span>${this.hostname}</span>
                        <div class="color-picker">
                            ${CONFIG.COLLABORATION.COLORS.map(c => `<div class="color-dot ${c === this.userColor ? 'active' : ''}" style="background-color: ${c}" data-color="${c}"></div>`).join('')}
                        </div>
                    </div>
                    <hr>
                    <div class="panel-row clickable" id="toggle-broadcast">
                        <span>共享我的视角</span>
                        <div class="switch ${this.isBroadcasting ? 'on' : ''}"></div>
                    </div>
                    <div class="panel-row clickable" id="toggle-follow">
                        <span>跟随主讲人</span>
                        <div class="switch ${this.isFollowing ? 'on' : ''}"></div>
                    </div>
                </div>
            </div>
        `;
        const div = document.createElement('div');
        div.innerHTML = html;
        this.container = div.firstElementChild;
        document.body.appendChild(this.container);

        this.sphere = this.container.querySelector('#markon-live-sphere');
        this.panel = this.container.querySelector('#markon-live-panel');

        // Restore position
        const savedPos = JSON.parse(localStorage.getItem('markon-live-pos') || '{"right": 20, "bottom": 20}');
        Object.assign(this.container.style, {
            position: 'fixed',
            right: `${savedPos.right}px`,
            bottom: `${savedPos.bottom}px`,
            zIndex: 9999
        });
    }

    _setupEventListeners() {
        // Toggle Panel
        this.sphere.addEventListener('click', (e) => {
            if (this.isDragging) return;
            this.panel.classList.toggle('show');
        });

        // Toggle Broadcast
        this.panel.querySelector('#toggle-broadcast').addEventListener('click', () => {
            this.isBroadcasting = !this.isBroadcasting;
            this._updateUIState();
        });

        // Toggle Follow
        this.panel.querySelector('#toggle-follow').addEventListener('click', () => {
            this.isFollowing = !this.isFollowing;
            this._updateUIState();
        });

        // Color Picker
        this.panel.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                this.userColor = dot.dataset.color;
                localStorage.setItem('markon-user-color', this.userColor);
                this._updateUIState();
            });
        });

        // Dragging
        this.sphere.addEventListener('mousedown', (e) => {
            this.isDragging = false;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            
            const onMouseMove = (me) => {
                if (Math.abs(me.clientX - this.dragStartX) > 5 || Math.abs(me.clientY - this.dragStartY) > 5) {
                    this.isDragging = true;
                    const right = window.innerWidth - me.clientX - 25;
                    const bottom = window.innerHeight - me.clientY - 25;
                    this.container.style.right = `${right}px`;
                    this.container.style.bottom = `${bottom}px`;
                }
            };
            
            const onMouseUp = (ue) => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (this.isDragging) {
                    localStorage.setItem('markon-live-pos', JSON.stringify({
                        right: parseInt(this.container.style.right),
                        bottom: parseInt(this.container.style.bottom)
                    }));
                }
            };
            
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // Broadcast Scroll (Debounced)
        let scrollTimeout;
        window.addEventListener('scroll', () => {
            if (!this.isBroadcasting) return;
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.broadcastAction('scroll_to');
            }, CONFIG.COLLABORATION.SYNC_DEBOUNCE);
        });
    }

    _updateUIState() {
        this.sphere.style.backgroundColor = this.userColor;
        this.sphere.classList.toggle('broadcasting', this.isBroadcasting);
        
        this.panel.querySelector('#toggle-broadcast .switch').classList.toggle('on', this.isBroadcasting);
        this.panel.querySelector('#toggle-follow .switch').classList.toggle('on', this.isFollowing);
        
        this.panel.querySelectorAll('.color-dot').forEach(dot => {
            dot.classList.toggle('active', dot.dataset.color === this.userColor);
        });

        const leaderInfo = this.sphere.querySelector('.leader-info');
        if (this.activeLeader && this.isFollowing) {
            leaderInfo.textContent = `Following ${this.activeLeader.name}`;
            leaderInfo.classList.add('show');
            this.sphere.style.backgroundColor = this.activeLeader.color;
        } else {
            leaderInfo.classList.remove('show');
        }
    }

    _getOrCreateClientId() {
        let id = sessionStorage.getItem('markon-client-id');
        if (!id) {
            id = Math.random().toString(36).substring(2, 11);
            sessionStorage.setItem('markon-client-id', id);
        }
        return id;
    }

    _loadSavedColor() {
        return localStorage.getItem('markon-user-color') || CONFIG.COLLABORATION.COLORS[0];
    }
}
