// script.js — complete rhythm game engine with Web Audio beat detection & timing
(function() {
    // ---------- DOM elements ----------
    const startScreen = document.getElementById('start-screen');
    const gameScreen = document.getElementById('game-screen');
    const resultScreen = document.getElementById('result-screen');
    const selectFileBtn = document.getElementById('select-file-btn');
    const audioFileInput = document.getElementById('audio-file');
    const fileNameSpan = document.getElementById('file-name');
    const startGameBtn = document.getElementById('start-game-btn');
    const backToMenuBtn = document.getElementById('back-to-menu');
    const playAgainBtn = document.getElementById('play-again');
    const playfield = document.getElementById('playfield');
    const scoreSpan = document.getElementById('score');
    const accuracySpan = document.getElementById('accuracy');
    const comboSpan = document.getElementById('combo');
    const missSpan = document.getElementById('miss');
    const hitFeedback = document.getElementById('hit-feedback');
    const progressBar = document.getElementById('progress-bar');

    // result elements
    const finalScore = document.getElementById('final-score');
    const finalAccuracy = document.getElementById('final-accuracy');
    finalAccuracy.innerText; // placeholder
    const finalCombo = document.getElementById('final-combo');
    const finalMiss = document.getElementById('final-miss');

    // ---------- global state ----------
    let audioContext = null;
    let analyser = null;
    let audioBuffer = null;
    let audioSource = null;
    let startTime = 0;            // audioContext current time when playback starts
    let animationFrame = null;
    let beats = [];               // array of beat timestamps (seconds)
    let notes = [];               // active notes { element, hitTime, judged }
    let gameActive = false;

    // scoring
    let score = 0;
    let totalNotes = 0;
    let perfectCount = 0;
    let goodCount = 0;
    let missCount = 0;
    let combo = 0;
    let maxCombo = 0;

    // timing windows (seconds)
    const WINDOW_PERFECT = 0.07;   // ±70ms
    const WINDOW_GOOD = 0.15;      // ±150ms

    // ---------- helper: reset stats ----------
    function resetStats() {
        score = 0; perfectCount = 0; goodCount = 0; missCount = 0; combo = 0; maxCombo = 0;
        updateStatsUI();
    }

    function updateStatsUI() {
        scoreSpan.innerText = score;
        const total = perfectCount + goodCount + missCount;
        if (total === 0) {
            accuracySpan.innerText = '100%';
        } else {
            const acc = ((perfectCount * 100 + goodCount * 70) / (total * 100) * 100).toFixed(1);
            accuracySpan.innerText = acc + '%';
        }
        comboSpan.innerText = combo;
        missSpan.innerText = missCount;
    }

    // ---------- beat detection using Web Audio ----------
    async function extractBeats(file) {
        const arrayBuffer = await file.arrayBuffer();
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        // create offline context for fast analysis
        const offlineCtx = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        const analyserNode = offlineCtx.createAnalyser();
        analyserNode.fftSize = 2048;
        source.connect(analyserNode);
        analyserNode.connect(offlineCtx.destination);
        source.start();

        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
        const beatTimestamps = [];
        const sampleRate = audioBuffer.sampleRate;
        const hopLength = 512; // samples between analysis
        const threshold = 200;  // energy threshold for beat (tuned for most pop/rock)

        await offlineCtx.startRendering().then(renderedBuffer => {
            // we don't need rendered audio, we just use analyser data during rendering?
            // Actually offline rendering does not call analyser repeatedly. We need to simulate.
            // Instead: use getByteFrequencyData per chunk via scripting? 
            // Simpler: use the actual audioContext and process in real time? but we need timestamps before game.
            // --- workaround: loop through audio in offline context manually using an AudioWorklet? no.
            // Simpler method: use peak detection on summed samples (naive but works for demo).
            // I will implement an energy-based beat detection by iterating over chunks.
        });

        // Because offline rendering doesn't give per-frame access, we implement a manual energy analysis
        // using the buffer data directly (RMS energy) – reliable enough for this demo.
        const channelData = audioBuffer.getChannelData(0); // left channel
        const windowSize = 1024;
        const step = 512; // 512 samples ~ 10ms at 44.1kHz
        let lastEnergy = 0;

        for (let i = 0; i < channelData.length - windowSize; i += step) {
            let sum = 0;
            for (let j = 0; j < windowSize; j++) {
                sum += channelData[i + j] * channelData[i + j];
            }
            const rms = Math.sqrt(sum / windowSize);
            // dynamic threshold: if rms > 1.5 * previous energy and above a noise floor
            if (rms > 0.015 && rms > lastEnergy * 1.4) {
                const timeSec = i / audioBuffer.sampleRate;
                beatTimestamps.push(timeSec);
            }
            lastEnergy = rms;
        }

        // filter out beats that are too close (< 200ms) – keep strongest
        const cleanedBeats = [];
        let minDistance = 0.18;
        for (let b of beatTimestamps) {
            if (cleanedBeats.length === 0 || b - cleanedBeats[cleanedBeats.length - 1] > minDistance) {
                cleanedBeats.push(b);
            }
        }
        return cleanedBeats.slice(0, 80); // limit to 80 notes for playability
    }

    // ---------- spawn notes from beats ----------
    function spawnNotesFromBeats(beatTimes) {
        notes.forEach(n => n.element.remove());
        notes = [];
        playfield.innerHTML = ''; // clear any old notes

        beatTimes.forEach(time => {
            const dot = document.createElement('div');
            dot.className = 'note';
            dot.style.top = '-60px'; // start above playfield
            // store absolute hit time (seconds)
            notes.push({
                element: dot,
                hitTime: time,
                judged: false,
                missed: false,
            });
            playfield.appendChild(dot);
        });
        totalNotes = notes.length;
    }

    // ---------- game loop ----------
    function startGameLoop() {
        if (!audioContext || !audioSource) return;
        startTime = audioContext.currentTime;
        gameActive = true;
        animationFrame = requestAnimationFrame(updateNotes);
    }

    function updateNotes() {
        if (!gameActive) return;
        const now = audioContext.currentTime - startTime; // elapsed seconds

        // update progress bar
        if (audioBuffer) {
            const prog = (now / audioBuffer.duration) * 100;
            progressBar.style.width = Math.min(prog, 100) + '%';
        }

        // end condition
        if (audioBuffer && now > audioBuffer.duration + 1) {
            endGame();
            return;
        }

        // judgement line Y coordinate (from bottom 70px)
        const judgementY = playfield.clientHeight - 70; // bottom line position
        const noteHeight = 52; // note height

        notes.forEach(note => {
            if (note.judged) return;
            const elapsed = now;
            const timeToHit = note.hitTime - elapsed;

            // map time to vertical position: note starts at top (y= -noteHeight) at time = hitTime - 2.0 seconds (approx)
            // we want note to reach judgement line exactly at hitTime. travel distance: playfield height + noteHeight
            const travelDistance = playfield.clientHeight + noteHeight; // from -52 to bottom+?
            const travelTime = 2.0; // seconds from top to judgement line (fixed)
            const yPos = (elapsed - (note.hitTime - travelTime)) / travelTime * travelDistance - noteHeight;

            // apply position (y relative to playfield top)
            if (!isNaN(yPos)) {
                note.element.style.top = Math.min(playfield.clientHeight, Math.max(-noteHeight, yPos)) + 'px';
            }

            // check for miss (passed judgement line without hit)
            if (!note.judged && yPos > judgementY + 20) {
                // missed
                note.judged = true;
                note.missed = true;
                combo = 0;
                missCount++;
                hitFeedback.innerText = 'miss';
                hitFeedback.className = 'hit-feedback miss';
                notes = notes.filter(n => n !== note); // remove
                note.element.remove();
                updateStatsUI();
            }
        });

        // hit detection on space handled by event listener (separate)
        animationFrame = requestAnimationFrame(updateNotes);
    }

    // ---------- handle space hit ----------
    function onSpaceHit(e) {
        if (e.code !== 'Space' || !gameActive) return;
        e.preventDefault();

        const now = audioContext.currentTime - startTime;
        let closestNote = null;
        let minDiff = Infinity;

        // find note closest to current time within windows
        notes.forEach(note => {
            if (note.judged) return;
            const diff = Math.abs(now - note.hitTime);
            if (diff < minDiff) {
                minDiff = diff;
                closestNote = note;
            }
        });

        if (!closestNote) return;

        if (minDiff <= WINDOW_GOOD) { // within 150ms
            closestNote.judged = true;
            let feedback = '';
            if (minDiff <= WINDOW_PERFECT) {
                score += 300;
                perfectCount++;
                feedback = 'perfect!';
                hitFeedback.className = 'hit-feedback perfect';
                combo++;
                closestNote.element.classList.add('perfect-hit');
            } else {
                score += 150;
                goodCount++;
                feedback = 'good';
                hitFeedback.className = 'hit-feedback good';
                combo++;
                closestNote.element.classList.add('good-hit');
            }
            hitFeedback.innerText = feedback;

            // update max combo
            if (combo > maxCombo) maxCombo = combo;

            // remove after visual feedback
            setTimeout(() => {
                if (closestNote.element.parentNode) closestNote.element.remove();
            }, 120);
            notes = notes.filter(n => n !== closestNote);
        } else {
            // pressed too early or late -> count as miss?
            // (optional miss, but we ignore to not double count)
        }
        updateStatsUI();
    }

    // ---------- end game ----------
    function endGame() {
        gameActive = false;
        if (animationFrame) cancelAnimationFrame(animationFrame);
        if (audioSource) audioSource.stop();

        // show result screen
        gameScreen.classList.remove('active');
        resultScreen.classList.add('active');

        finalScore.innerText = score;
        const total = perfectCount + goodCount + missCount;
        const acc = total ? ((perfectCount * 100 + goodCount * 70) / (total * 100) * 100).toFixed(1) : '100';
        finalAccuracy.innerText = acc + '%';
        finalCombo.innerText = maxCombo;
        finalMiss.innerText = missCount;

        // cleanup notes
        notes.forEach(n => n.element.remove());
        notes = [];
    }

    // ---------- load song & start ----------
    async function loadSongAndStart(file) {
        try {
            beatTimes = await extractBeats(file);
            if (beatTimes.length === 0) beatTimes = [1, 2, 3, 4, 5, 6]; // fallback

            resetStats();
            spawnNotesFromBeats(beatTimes);

            // resume audio context if suspended
            if (audioContext.state === 'suspended') await audioContext.resume();

            // create source from buffer
            audioSource = audioContext.createBufferSource();
            audioSource.buffer = audioBuffer;
            analyser = audioContext.createAnalyser();
            audioSource.connect(analyser);
            analyser.connect(audioContext.destination);

            audioSource.start();
            startGameLoop();

            // switch UI
            startScreen.classList.remove('active');
            gameScreen.classList.add('active');
        } catch (e) {
            alert('error analysing audio: ' + e.message);
        }
    }

    // ---------- event listeners ----------
    selectFileBtn.addEventListener('click', () => audioFileInput.click());
    audioFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            fileNameSpan.innerText = file.name;
            startGameBtn.disabled = false;
        }
    });

    startGameBtn.addEventListener('click', async () => {
        const file = audioFileInput.files[0];
        if (!file) return;
        startGameBtn.disabled = true; // prevent double click
        await loadSongAndStart(file);
    });

    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            onSpaceHit(e);
        }
    });

    backToMenuBtn.addEventListener('click', () => {
        gameActive = false;
        if (animationFrame) cancelAnimationFrame(animationFrame);
        if (audioSource) audioSource.stop();
        gameScreen.classList.remove('active');
        startScreen.classList.add('active');
        // reset
        notes.forEach(n => n.element.remove());
        notes = [];
        progressBar.style.width = '0%';
    });

    playAgainBtn.addEventListener('click', () => {
        resultScreen.classList.remove('active');
        startScreen.classList.add('active');
        audioFileInput.value = '';
        fileNameSpan.innerText = 'no file selected';
        startGameBtn.disabled = true;
    });

    // Prevent page scroll on space
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') e.preventDefault();
    }, false);

    // initialise audio context on any user gesture (browsers require)
    document.body.addEventListener('click', () => {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') audioContext.resume();
    }, { once: true });

})();
