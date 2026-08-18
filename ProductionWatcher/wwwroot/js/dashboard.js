(function () {
    'use strict';

    const configuredPollMs = parseInt($('.dashboard-container').data('poll-interval-ms'), 10);
    const POLL_INTERVAL_MS = Number.isFinite(configuredPollMs) && configuredPollMs >= 500
        ? configuredPollMs
        : 2000;
    let pollTimer = null;
    let currentServerIps = [];
    let isPolling = false;
    let consecutiveFailures = 0;
    const passWaitState = new Map();
    let passWaitTimerInterval = null;
    const lastStationStatus = new Map();

    function formatElapsedDuration(elapsedMs) {
        const totalSeconds = Math.floor(elapsedMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        }
        return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function startPassWaitClock() {
        if (passWaitTimerInterval) {
            return;
        }
        passWaitTimerInterval = setInterval(updatePassWaitDisplays, 1000);
    }

    function stopPassWaitClock() {
        if (passWaitTimerInterval) {
            clearInterval(passWaitTimerInterval);
            passWaitTimerInterval = null;
        }
    }

    function updatePassWaitDisplays() {
        passWaitState.forEach(function (state, key) {
            const $card = findStationCard(key);
            if (!$card.length) {
                return;
            }
            const elapsed = Date.now() - state.passedAt;
            $card.find('.pass-wait-timer').text(formatElapsedDuration(elapsed));
        });
    }

    function clearPassWaitState() {
        passWaitState.clear();
        lastStationStatus.clear();
        stopPassWaitClock();
    }

    function processPassWaitTracker(key, rawStation, previousStatusClass) {
        const station = normalizeStation(rawStation);

        if (station.statusCssClass === 'status-passed') {
            let state = passWaitState.get(key);
            const passCount = station.passedProcessCount;
            const isNewPass = !state
                || previousStatusClass !== 'status-passed'
                || (passCount > 0 && state.passFlag !== passCount);

            if (isNewPass) {
                passWaitState.set(key, {
                    passedAt: Date.now(),
                    passFlag: passCount > 0 ? passCount : (state ? state.passFlag + 1 : 1),
                    lastSerial: station.serialNumber
                });
            }

            startPassWaitClock();
            return;
        }

        if (station.statusCssClass === 'status-running' || station.statusCssClass === 'status-waiting') {
            passWaitState.delete(key);
        } else if (station.statusCssClass !== 'status-passed') {
            passWaitState.delete(key);
        }

        if (passWaitState.size === 0) {
            stopPassWaitClock();
        }

        lastStationStatus.set(key, station.statusCssClass);
    }

    function buildPassWaitPanelHtml(state) {
        const elapsed = formatElapsedDuration(Date.now() - state.passedAt);
        return `
            <div class="pass-wait-panel" title="Waiting for next test to start">
                <div class="pass-flag" aria-hidden="true">
                    <span class="pass-flag-pole"></span>
                    <span class="pass-flag-banner"></span>
                </div>
                <div class="pass-wait-timer">${elapsed}</div>
                <div class="pass-wait-label">Next test</div>
            </div>`;
    }

    function syncPassWaitPanel($card, key, station) {
        const state = passWaitState.get(key);
        const $panel = $card.find('.pass-wait-panel');
        const shouldShow = station.statusCssClass === 'status-passed' && state;

        if (!shouldShow) {
            $card.removeClass('has-pass-wait');
            $panel.remove();
            return;
        }

        $card.addClass('has-pass-wait');
        if ($panel.length === 0) {
            $card.find('.station-body').append(buildPassWaitPanelHtml(state));
        } else {
            $panel.find('.pass-wait-timer').text(formatElapsedDuration(Date.now() - state.passedAt));
        }
    }

    const $serverIpInput = $('#serverIpInput');
    const $connectBtn = $('#connectBtn');
    const $disconnectBtn = $('#disconnectBtn');
    const $connectionStatus = $('#connectionStatus');
    const $stationGrid = $('#stationGrid');

    function getApiField(station, snakeCase, camelCase, fallback) {
        if (station[snakeCase] !== undefined && station[snakeCase] !== null && station[snakeCase] !== '') {
            return station[snakeCase];
        }
        if (station[camelCase] !== undefined && station[camelCase] !== null && station[camelCase] !== '') {
            return station[camelCase];
        }
        return fallback;
    }

    function parseServerIps(value) {
        return value
            .split(/[,;\n\r]+/)
            .map(function (ip) { return ip.trim(); })
            .filter(function (ip) { return ip.length > 0; });
    }

    function normalizeStation(station) {
        const serialNumber = getApiField(station, 'current_serial_number', 'currentSerialNumber', '');
        return {
            stationId: getApiField(station, 'station_id', 'stationId', 0),
            stationName: getApiField(station, 'station_name', 'stationName', 'Unknown Station'),
            serverIp: getApiField(station, 'server_ip', 'serverIp', ''),
            statusLabel: getApiField(station, 'status_label', 'statusLabel', 'Unknown'),
            statusCssClass: getApiField(station, 'status_css_class', 'statusCssClass', 'status-unknown'),
            serialNumber: serialNumber,
            passedProcessCount: parseInt(getApiField(station, 'passed_process_count', 'passedProcessCount', 0), 10) || 0
        };
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function setConnectionStatus(message, type, errors) {
        $connectionStatus
            .removeClass('connected error polling')
            .addClass(type || '');

        let html = escapeHtml(message || '');
        if (errors && errors.length > 0) {
            html += errors.map(function (err) {
                const serverIp = escapeHtml(err.server_ip || err.serverIp || 'Unknown server');
                const errorText = escapeHtml(err.error || 'Connection failed');
                return '<span class="server-error">' + serverIp + ': ' + errorText + '</span>';
            }).join('');
        }

        $connectionStatus.html(html);
    }

    function buildStationCard(rawStation) {
        const station = normalizeStation(rawStation);
        const cardKey = station.serverIp + '-' + station.stationId;
        const state = passWaitState.get(cardKey);
        const passWaitHtml = station.statusCssClass === 'status-passed' && state
            ? buildPassWaitPanelHtml(state)
            : '';
        const hasPassWait = passWaitHtml ? ' has-pass-wait' : '';

        return `
            <div class="station-card ${station.statusCssClass}${hasPassWait}" data-station-key="${escapeHtml(cardKey)}" title="${escapeHtml(station.stationName)}">
                <div class="station-body">
                    <div class="station-main">
                        <div class="station-name">${escapeHtml(station.stationName)}</div>
                        <div class="station-meta">
                            <span class="status-badge">${escapeHtml(station.statusLabel)}</span>
                            ${station.serialNumber ? `<span class="station-serial">${escapeHtml(station.serialNumber)}</span>` : ''}
                        </div>
                    </div>
                    ${passWaitHtml}
                </div>
            </div>`;
    }

    const $container = $('.dashboard-container');
    const RACK_COUNT = parseInt($container.data('rack-count'), 10) || 6;
    const SLOTS_PER_RACK = parseInt($container.data('slots-per-rack'), 10) || 3;

    function extractStationNumber(rawStation) {
        const normalized = normalizeStation(rawStation);
        const nameMatch = normalized.stationName.match(/(\d+)\s*$/);
        if (nameMatch) {
            return parseInt(nameMatch[1], 10);
        }
        if (normalized.stationId) {
            return normalized.stationId;
        }
        return null;
    }

    function buildRackLayout(stations) {
        const racks = Array.from({ length: RACK_COUNT }, function () {
            return Array(SLOTS_PER_RACK).fill(null);
        });
        const overflow = [];
        const numbered = stations.map(function (station) {
            return { station: station, num: extractStationNumber(station) };
        });
        const validNumbers = numbered
            .filter(function (item) { return item.num !== null; })
            .map(function (item) { return item.num; });

        if (validNumbers.length === 0) {
            return { racks: racks, overflow: stations, useRackLayout: false };
        }

        const minNum = Math.min.apply(null, validNumbers);

        numbered.forEach(function (item) {
            if (item.num === null) {
                overflow.push(item.station);
                return;
            }

            const offset = item.num - minNum;
            const rackIndex = Math.floor(offset / SLOTS_PER_RACK);
            const slotIndex = offset % SLOTS_PER_RACK;

            if (rackIndex >= 0 && rackIndex < RACK_COUNT) {
                if (racks[rackIndex][slotIndex]) {
                    overflow.push(item.station);
                } else {
                    racks[rackIndex][slotIndex] = item.station;
                }
            } else {
                overflow.push(item.station);
            }
        });

        return { racks: racks, overflow: overflow, useRackLayout: true };
    }

    function buildRackSlotHtml(station) {
        if (!station) {
            return '<div class="rack-slot rack-slot-empty" aria-hidden="true"></div>';
        }
        return '<div class="rack-slot">' + buildStationCard(station) + '</div>';
    }

    function buildRackLayoutHtml(stations) {
        const layout = buildRackLayout(stations);
        if (!layout.useRackLayout) {
            return '<div class="station-grid">' + stations.map(buildStationCard).join('') + '</div>';
        }

        let html = '<div class="rack-layout">';
        layout.racks.forEach(function (slots, rackIndex) {
            html += `
                <div class="rack-column">
                    <div class="rack-header">Rack ${rackIndex + 1}</div>
                    <div class="rack-slots">
                        ${slots.map(buildRackSlotHtml).join('')}
                    </div>
                </div>`;
        });
        html += '</div>';

        if (layout.overflow.length > 0) {
            html += `
                <div class="rack-overflow">
                    <div class="rack-overflow-title">Other stations</div>
                    <div class="station-grid">${layout.overflow.map(buildStationCard).join('')}</div>
                </div>`;
        }

        return html;
    }

    function buildServerSectionHtml(serverLabel, serverStations) {
        return `
            <div class="server-section">
                <h2 class="server-section-title">${escapeHtml(serverLabel)} <span class="server-section-count">(${serverStations.length})</span></h2>
                ${buildRackLayoutHtml(serverStations)}
            </div>`;
    }

    function getDensityTier(stationCount) {
        if (stationCount <= 18) return 'lg';
        if (stationCount <= 35) return 'md';
        if (stationCount <= 55) return 'sm';
        return 'xs';
    }

    function getDensityConfig(tier) {
        const configs = {
            lg: { minCard: 155, gap: 10, maxCols: 6, targetRows: 3, nameSize: '0.92rem', badgeSize: '0.78rem', serialSize: '0.6rem', minHeight: 78 },
            md: { minCard: 145, gap: 9,  maxCols: 6, targetRows: 3, nameSize: '0.85rem', badgeSize: '0.74rem', serialSize: '0.58rem', minHeight: 74 },
            sm: { minCard: 135, gap: 8,  maxCols: 6, targetRows: 3, nameSize: '0.8rem',  badgeSize: '0.7rem',  serialSize: '0.55rem', minHeight: 70 },
            xs: { minCard: 125, gap: 8,  maxCols: 6, targetRows: 3, nameSize: '0.76rem', badgeSize: '0.66rem', serialSize: '0.52rem', minHeight: 66 }
        };
        return configs[tier] || configs.lg;
    }

    function applyAdaptiveLayout(stationCount, stationsPerSection) {
        const container = document.querySelector('.dashboard-container');
        if (!container) {
            return;
        }

        const sectionCount = stationsPerSection || stationCount;
        const tier = getDensityTier(sectionCount);
        const config = getDensityConfig(tier);

        container.dataset.layout = 'rack';
        container.dataset.density = tier;
        container.dataset.stationCount = String(stationCount);
        container.dataset.sectionCount = String(sectionCount);
        container.style.setProperty('--rack-count', String(RACK_COUNT));
        container.style.setProperty('--grid-gap', config.gap + 'px');
        container.style.setProperty('--card-name-size', config.nameSize);
        container.style.setProperty('--card-badge-size', config.badgeSize);
        container.style.setProperty('--card-serial-size', config.serialSize);
        container.style.setProperty('--card-min-height', config.minHeight + 'px');
    }

    let resizeTimer = null;
    function scheduleLayoutRefresh() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            const count = parseInt($('.dashboard-container').attr('data-station-count'), 10);
            const sectionCount = parseInt($('.dashboard-container').attr('data-section-count'), 10);
            if (count > 0) {
                applyAdaptiveLayout(count, sectionCount || count);
            }
        }, 150);
    }

    function groupStationsByServer(stations) {
        const groups = new Map();
        stations.forEach(function (station) {
            const normalized = normalizeStation(station);
            const serverIp = normalized.serverIp || 'Unknown Server';
            if (!groups.has(serverIp)) {
                groups.set(serverIp, []);
            }
            groups.get(serverIp).push(station);
        });
        return groups;
    }

    function stationCardKey(rawStation) {
        const station = normalizeStation(rawStation);
        return station.serverIp + '-' + station.stationId;
    }

    const STATUS_CLASSES = ['status-passed', 'status-running', 'status-waiting', 'status-failed', 'status-aborted', 'status-unknown'];

    function buildStructureSignature(stations, serverIps) {
        const groups = groupStationsByServer(stations);
        const sectionKeys = Array.from(groups.keys()).sort();
        const stationKeys = stations.map(stationCardKey).sort();
        return serverIps.join(',') + '||' + sectionKeys.join(',') + '||' + stationKeys.join(',');
    }

    function findStationCard(key) {
        return $stationGrid.find('.station-card').filter(function () {
            return this.getAttribute('data-station-key') === key;
        });
    }

    function patchStationCard($card, rawStation) {
        const station = normalizeStation(rawStation);
        const key = station.serverIp + '-' + station.stationId;
        const currentStatus = STATUS_CLASSES.find(function (cls) { return $card.hasClass(cls); });

        processPassWaitTracker(key, rawStation, currentStatus);

        if (currentStatus !== station.statusCssClass) {
            STATUS_CLASSES.forEach(function (cls) { $card.removeClass(cls); });
            $card.addClass(station.statusCssClass);
        }

        if ($card.attr('title') !== station.stationName) {
            $card.attr('title', station.stationName);
        }

        const $name = $card.find('.station-name');
        if ($name.text() !== station.stationName) {
            $name.text(station.stationName);
        }

        const $badge = $card.find('.status-badge');
        if ($badge.text() !== station.statusLabel) {
            $badge.text(station.statusLabel);
        }

        const $meta = $card.find('.station-meta');
        let $serial = $meta.find('.station-serial');
        if (station.serialNumber) {
            if ($serial.length === 0) {
                $serial = $('<span class="station-serial"></span>').appendTo($meta);
            }
            if ($serial.text() !== station.serialNumber) {
                $serial.text(station.serialNumber);
            }
        } else if ($serial.length) {
            $serial.remove();
        }

        syncPassWaitPanel($card, key, station);
    }

    function applyPassWaitToStations(stations) {
        stations.forEach(function (rawStation) {
            const key = stationCardKey(rawStation);
            const previousStatus = lastStationStatus.get(key) || null;
            processPassWaitTracker(key, rawStation, previousStatus);

            const $card = findStationCard(key);
            if ($card.length) {
                syncPassWaitPanel($card, key, normalizeStation(rawStation));
            }
        });
    }

    function renderStationsFull(stations, serverIps) {
        if (!stations || stations.length === 0) {
            $('.dashboard-container').removeAttr('data-density data-station-count data-section-count');
            $stationGrid.html(`
                <div class="empty-state">
                    <p>No stations found on the connected server(s).</p>
                </div>`);
            return;
        }

        const groups = groupStationsByServer(stations);
        const showServerSections = serverIps.length > 1 || groups.size > 1;
        const serversToRender = groups.size > 0
            ? Array.from(groups.keys())
            : serverIps;
        let html = '';

        if (showServerSections) {
            serversToRender.forEach(function (serverIp) {
                const serverStations = groups.get(serverIp) || [];
                if (serverStations.length === 0) {
                    return;
                }

                html += buildServerSectionHtml(serverIp, serverStations);
            });
        } else {
            html = buildRackLayoutHtml(stations);
        }

        $stationGrid.html(html);

        let maxSectionSize = stations.length;
        if (showServerSections) {
            maxSectionSize = Math.max.apply(null, Array.from(groups.values()).map(function (s) { return s.length; }));
        }
        applyAdaptiveLayout(stations.length, maxSectionSize);
        applyPassWaitToStations(stations);
        updatePassWaitDisplays();
    }

    function updateStations(stations, serverIps) {
        if (!stations || stations.length === 0) {
            $stationGrid.removeAttr('data-signature');
            $('.dashboard-container').removeAttr('data-density data-station-count data-section-count');
            $stationGrid.html(`
                <div class="empty-state">
                    <p>No stations found on the connected server(s).</p>
                </div>`);
            return;
        }

        const signature = buildStructureSignature(stations, serverIps);
        if ($stationGrid.attr('data-signature') !== signature) {
            renderStationsFull(stations, serverIps);
            $stationGrid.attr('data-signature', signature);
            return;
        }

        stations.forEach(function (rawStation) {
            const key = stationCardKey(rawStation);
            const $card = findStationCard(key);
            if ($card.length) {
                patchStationCard($card, rawStation);
            }
        });
        updatePassWaitDisplays();
    }

    function fetchStations() {
        if (currentServerIps.length === 0) {
            return;
        }

        $.ajax({
            url: '/Dashboard/Stations',
            method: 'GET',
            data: { serverIp: currentServerIps.join(',') },
            dataType: 'json',
            timeout: 15000
        })
            .done(function (response) {
                consecutiveFailures = 0;
                const stations = response.stations || response.Stations || response;
                const errors = response.errors || response.Errors || [];
                updateStations(stations, currentServerIps);

                const now = new Date().toLocaleTimeString();
                const serverCount = currentServerIps.length;
                const stationCount = Array.isArray(stations) ? stations.length : 0;
                let statusMessage = serverCount + ' server(s), ' + stationCount + ' station(s) — Updated ' + now;

                if (errors.length > 0 && stationCount > 0) {
                    setConnectionStatus(statusMessage, 'connected', errors);
                } else if (errors.length > 0) {
                    setConnectionStatus('Failed to connect to all servers.', 'error', errors);
                } else {
                    setConnectionStatus(statusMessage, 'connected');
                }
            })
            .fail(function (xhr) {
                consecutiveFailures++;
                let message = 'Failed to fetch station data.';
                let errors = [];

                if (xhr.status === 0) {
                    message = 'Dashboard server not reachable. Is the app still running?';
                } else if (xhr.responseJSON) {
                    if (xhr.responseJSON.error) {
                        message = xhr.responseJSON.error;
                    }
                    errors = xhr.responseJSON.errors || xhr.responseJSON.Errors || [];
                } else if (xhr.statusText === 'timeout') {
                    message = 'Connection timed out.';
                }

                setConnectionStatus(message, 'error', errors);

                if (xhr.status === 0 || consecutiveFailures >= 3) {
                    stopPolling();
                    $connectBtn.prop('disabled', false);
                    $disconnectBtn.prop('disabled', true);
                    $serverIpInput.prop('disabled', false);
                    isPolling = false;
                }
            });
    }

    function startPolling() {
        stopPolling();
        fetchStations();
        pollTimer = setInterval(fetchStations, POLL_INTERVAL_MS);
        isPolling = true;
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        isPolling = false;
    }

    function connect() {
        const serverIps = parseServerIps($serverIpInput.val());
        if (serverIps.length === 0) {
            setConnectionStatus('Please enter at least one server IP address.', 'error');
            $serverIpInput.focus();
            return;
        }

        currentServerIps = serverIps;
        consecutiveFailures = 0;
        $connectBtn.prop('disabled', true);
        $disconnectBtn.prop('disabled', false);
        $serverIpInput.prop('disabled', true);
        setConnectionStatus('Connecting to ' + serverIps.length + ' server(s)...', 'polling');

        startPolling();
    }

    function disconnect() {
        stopPolling();
        clearPassWaitState();
        currentServerIps = [];
        $connectBtn.prop('disabled', false);
        $disconnectBtn.prop('disabled', true);
        $serverIpInput.prop('disabled', false);
        setConnectionStatus('', '');
        $stationGrid.removeAttr('data-signature');
        $('.dashboard-container').removeAttr('data-density data-station-count data-section-count');
        $stationGrid.html(`
            <div class="empty-state">
                <p>Enter one server address per comma-separated entry, then click <strong>Connect</strong>.</p>
            </div>`);
    }

    $connectBtn.on('click', connect);
    $disconnectBtn.on('click', disconnect);

    $serverIpInput.on('keydown', function (e) {
        if (e.key === 'Enter' && !isPolling) {
            e.preventDefault();
            connect();
        }
    });

    $(window).on('resize', scheduleLayoutRefresh);
    $(window).on('beforeunload', function () {
        stopPolling();
        stopPassWaitClock();
    });
})();
