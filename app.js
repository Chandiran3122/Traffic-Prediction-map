document.addEventListener('DOMContentLoaded', () => {
            const statusMessage = document.getElementById('status-message');
            const viewModeBtns = document.querySelectorAll('.view-mode-btn');
            const toast = document.getElementById('toast');
            const loader = document.getElementById('loader');
            const citySearchInput = document.getElementById('city-search');
            const searchCityBtn = document.getElementById('search-city-btn');
            const sourceInput = document.getElementById('source-input');
            const destinationInput = document.getElementById('destination-input');
            const findRouteBtn = document.getElementById('find-route-btn');
            const clearRouteBtn = document.getElementById('clear-route-btn');
            
            const map = L.map('map').setView([11.0168, 76.9558], 13);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
                subdomains: 'abcd',
                maxZoom: 20
            }).addTo(map);

            let trafficLayers = L.layerGroup().addTo(map);
            let liveTrafficData = [];
            let currentViewMode = 'live';
            let currentRoadNetwork = [];
            let routingControl = null;
            let trafficUpdateInterval = null;
            
            statusMessage.textContent = 'Enter a source and destination to begin.';

            // --- TRAFFIC GENERATION & PREDICTION (DYNAMIC) ---
            function generateRealTimeTraffic(roadNetwork) {
                if (!roadNetwork || roadNetwork.length === 0) return [];
                const date = new Date();
                const hour = date.getHours();
                const day = date.getDay();

                const isWeekday = day > 0 && day < 6;
                const isRushHour = isWeekday && ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20));
                
                return roadNetwork.map(road => {
                    let randomFactor = Math.random();
                    let status = 'free', heavyProb = 0.1;

                    if (isRushHour) heavyProb = 0.4;
                    // In a route, every segment is important, so we don't differentiate by road type
                    if (randomFactor < heavyProb) status = 'heavy';
                    else if (randomFactor < heavyProb + 0.35) status = 'moderate';
                    else status = 'free';

                    return { ...road, status };
                });
            }

            function predictTraffic(baseData) {
                return baseData.map(road => {
                    let { status } = road;
                    let newStatus = status;
                    if (status === 'heavy' && Math.random() < 0.8) newStatus = 'heavy';
                    else if (status === 'moderate' && Math.random() < 0.4) newStatus = 'heavy';
                    else if (status === 'free' && Math.random() < 0.3) newStatus = 'moderate';
                    return { ...road, status: newStatus, predicted: true };
                });
            }

            // --- VISUALIZATION ---
            function getTrafficStyle(status) {
                switch (status) {
                    case 'heavy': return { className: 'leaflet-heavy-traffic', weight: 8 };
                    case 'moderate': return { className: 'leaflet-moderate-traffic', weight: 6 };
                    case 'free': return { className: 'leaflet-free-traffic', weight: 5 };
                    default: return { color: 'grey', weight: 5 };
                }
            }

            function drawTraffic(trafficData) {
                trafficLayers.clearLayers();
                trafficData.forEach(road => {
                    const style = getTrafficStyle(road.status);
                    const polyline = L.polyline(road.coords, style);
                    polyline.bindTooltip(`${road.name || 'Route Segment'}<br><b>Status:</b> ${road.status.charAt(0).toUpperCase() + road.status.slice(1)}`, {
                        className: 'bg-gray-800 text-white border-0 rounded-md shadow-lg', permanent: false, sticky: true
                    });
                    trafficLayers.addLayer(polyline);
                });
            }
            
            // --- LOCATION SEARCH & ROUTING LOGIC ---
            async function geocodeAddress(query) {
                try {
                    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
                    const data = await response.json();
                    if (data && data.length > 0) {
                        return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
                    }
                    return null;
                } catch (error) {
                    console.error("Geocoding error:", error);
                    return null;
                }
            }
            
            async function findAndDisplayRoute() {
                const sourceQuery = sourceInput.value;
                const destQuery = destinationInput.value;

                if (!sourceQuery || !destQuery) {
                    showToast("Please enter both source and destination.", "error");
                    return;
                }
                
                clearRoute();
                loader.classList.remove('hidden');
                statusMessage.textContent = 'Finding locations...';
                
                const [sourceCoords, destCoords] = await Promise.all([geocodeAddress(sourceQuery), geocodeAddress(destQuery)]);
                
                if (!sourceCoords || !destCoords) {
                    showToast("Could not find one or both locations.", "error");
                    loader.classList.add('hidden');
                    return;
                }

                statusMessage.textContent = 'Calculating route...';

                routingControl = L.Routing.control({
                    waypoints: [
                        L.latLng(sourceCoords.lat, sourceCoords.lon),
                        L.latLng(destCoords.lat, destCoords.lon)
                    ],
                    routeWhileDragging: false,
                    addWaypoints: false,
                    createMarker: function(i, waypoint, n) { 
                        return L.marker(waypoint.latLng)
                            .bindPopup(i === 0 ? `<b>Start:</b><br>${sourceQuery}` : `<b>End:</b><br>${destQuery}`)
                            .openPopup();
                    },
                    lineOptions: { styles: [{opacity: 0}] } // Hide default line
                }).addTo(map);

                routingControl.on('routesfound', function(e) {
                    const route = e.routes[0];
                    const routeCoordinates = route.coordinates;
                    
                    const segments = [];
                    for (let i = 0; i < routeCoordinates.length - 1; i++) {
                        segments.push({
                            id: `route-segment-${i}`,
                            coords: [
                                [routeCoordinates[i].lat, routeCoordinates[i].lng],
                                [routeCoordinates[i+1].lat, routeCoordinates[i+1].lng]
                            ]
                        });
                    }
                    currentRoadNetwork = segments;
                    updateTrafficSimulation();
                    map.fitBounds(L.latLngBounds(routeCoordinates));
                    statusMessage.textContent = 'Route traffic displayed.';
                    loader.classList.add('hidden');

                    // Start live updates for the route
                    trafficUpdateInterval = setInterval(updateTrafficSimulation, 30000);
                });

                routingControl.on('routingerror', function(e) {
                    showToast("Could not find a route between these locations.", "error");
                    statusMessage.textContent = 'Route finding failed.';
                    loader.classList.add('hidden');
                });
            }
            
            async function geocodeAndMoveMap() {
                const query = citySearchInput.value;
                if (!query) return;
                
                clearRoute();
                
                loader.classList.remove('hidden');
                const coords = await geocodeAddress(query);
                if (coords) {
                    map.setView([coords.lat, coords.lon], 13);
                    showToast(`Moved map to ${query.split(',')[0]}`, "success");
                    statusMessage.textContent = `Now in ${query.split(',')[0]}. Enter a route.`;
                } else {
                    showToast("Location not found.", "error");
                    statusMessage.textContent = 'Location search failed.';
                }
                loader.classList.add('hidden');
            }

            function clearRoute() {
                if (routingControl) {
                    map.removeControl(routingControl);
                    routingControl = null;
                }
                trafficLayers.clearLayers();
                if (trafficUpdateInterval) {
                    clearInterval(trafficUpdateInterval);
                    trafficUpdateInterval = null;
                }
                currentRoadNetwork = [];
                liveTrafficData = [];
                statusMessage.textContent = 'Route cleared. Enter a new route to begin.';
            }

            // --- EVENT HANDLERS & MAIN CONTROL ---
            function updateActiveButton(activeMode) {
                 viewModeBtns.forEach(btn => {
                    btn.classList.toggle('bg-blue-600', btn.dataset.mode === activeMode);
                    btn.classList.toggle('ring-2', btn.dataset.mode === activeMode);
                    btn.classList.toggle('ring-blue-400', btn.dataset.mode === activeMode);
                    btn.classList.toggle('bg-gray-600', btn.dataset.mode !== activeMode);
                });
            }

            function updateTrafficSimulation() {
                if (currentRoadNetwork.length === 0) return; // Don't simulate if no route
                liveTrafficData = generateRealTimeTraffic(currentRoadNetwork);
                if (currentViewMode === 'live') {
                    drawTraffic(liveTrafficData);
                    statusMessage.textContent = "Showing Live Route Traffic";
                } else {
                    const predictedData = predictTraffic(liveTrafficData);
                    drawTraffic(predictedData);
                    statusMessage.textContent = `Predicted Traffic in ${currentViewMode} mins`;
                }
            }
            
            viewModeBtns.forEach(button => {
                button.addEventListener('click', () => {
                    currentViewMode = button.dataset.mode;
                    updateActiveButton(currentViewMode);
                    updateTrafficSimulation();
                });
            });

            searchCityBtn.addEventListener('click', geocodeAndMoveMap);
            citySearchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') geocodeAndMoveMap(); });
            findRouteBtn.addEventListener('click', findAndDisplayRoute);
            clearRouteBtn.addEventListener('click', () => {
                clearRoute();
                sourceInput.value = '';
                destinationInput.value = '';
            });

            function showToast(message, type = "success") {
                toast.textContent = message;
                toast.className = `absolute bottom-5 right-5 text-white py-2 px-5 rounded-lg shadow-xl text-sm transition-opacity duration-300 ${type === 'success' ? 'bg-green-500' : 'bg-red-500'}`;
                toast.classList.remove('hidden');
                setTimeout(() => toast.classList.add('opacity-0'), 3000);
                setTimeout(() => { toast.classList.add('hidden'); toast.classList.remove('opacity-0'); }, 3300);
            }
        });