const request = require('request');
const EventEmitter = require('events');
const Quake = require('./quake');

module.exports = class {
    constructor(config, logger) {
        this.config = config;
        this.cache = {};
        this.recentQuakes = {};
        this.lastQueryTime = new Date();
        this.logger = logger || console;
        this.events = new EventEmitter();
        this.quakeSearchBoxCoordinates = null;
        // this.quakeSearchBoxCoordinates = [
        //     162.99316, -48.77791,
        //     182.37305, -31.76554
        // ];
        this.urlQuakeSearch = 'https://quakesearch.geonet.org.nz/geojson';
        this.urlQuakePage = 'https://www.geonet.org.nz/earthquake/';
        this.urlQuakeQuery = 'https://api.geonet.org.nz/quake/';
    }

    getAllQuakes() {
        return this.cache;
    }

    queryAllQuakes() {
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - this.config.quake_cache_ttl_days);
        this.queryQuakes(fromDate);
    }

    checkForNewQuakes() {
        const fromDate = new Date(this.lastQueryTime.getTime() - this.config.quake_search_time_minutes * 60000);
        return this.queryQuakes(fromDate);
    }

    queryQuakes(fromDate) {
        // {
        //     "type": "FeatureCollection",
        //     "features": [{
        //         "type": "Feature",
        //         "geometry": {"type": "Point", "coordinates": [173.7379913, -42.24602127]},
        //         "properties": {
        //             "publicid": "2016p862895",
        //             "eventtype": "earthquake",
        //             "origintime": "2016-11-15T06:30:33.216Z",
        //             "modificationtime": "2016-11-15T06:41:10.068Z",
        //             "depth": 7.478375912,
        //             "magnitude": 5.779644657,
        //             "magnitudetype": "M",
        //             "evaluationmethod": "LOCSAT",
        //             "evaluationstatus": "confirmed",
        //             "evaluationmode": "manual",
        //             "earthmodel": "iasp91",
        //             "usedphasecount": 10,
        //             "usedstationcount": 6,
        //             "minimumdistance": 0.2250061333,
        //             "azimuthalgap": 179.8320503,
        //             "originerror": 0.4994083478,
        //             "magnitudestationcount": 157
        //         }
        //     }]
        // }
        this.lastQueryTime = new Date();

        let url = this.urlQuakeSearch +
            `?minmag=${this.config.min_magnitude}` +
            `&maxdepth=${this.config.max_depth_km}` +
            `&startdate=${fromDate.toISOString().split('.')[0]}`;
        if (this.quakeSearchBoxCoordinates) {
            url += `?bbox=${this.quakeSearchBoxCoordinates.join(',')}`;
        }
        this.logger.log(`Fetching quakes: ${url}`);
        request.get(url, (error, response, body) => {
            if (error || response.statusCode !== 200) {
                return this.logger.error('Failed to contact geonet. ' + error);
            }
            const geonetResponse = JSON.parse(body);
            const updatedQuakes = [];

            for (const feature of geonetResponse.features) {
                /** @param feature.publicid */
                /** @param feature.origintime */
                /** @param feature.modificationtime */
                const quake = new Quake(feature.properties.publicid);
                quake.url = this.urlQuakePage + quake.id;
                this.parseCommonFeatureFields(quake, feature);
                quake.time = feature.properties.origintime;
                quake.modified = feature.properties.modificationtime;

                const cachedQuake = this.cache.hasOwnProperty(quake.id) ? this.cache[quake.id] : null;
                if (!cachedQuake) {
                    updatedQuakes.push(quake);
                    this.cacheQuake(quake);
                } else if (!cachedQuake.equals(quake)) {
                    cachedQuake.update(quake);
                    updatedQuakes.push(cachedQuake);
                }
            }
            this.syncUpdatedQuakes(updatedQuakes);
            this.refreshRecentQuakes();
        });
    }

    refreshQuake(quake) {
        // https://api.geonet.org.nz/quake/2016p862895
        // {
        //     "type": "FeatureCollection",
        //     "features": [{
        //         "type": "Feature",
        //         "geometry": {"type": "Point", "coordinates": [172.9809723, -43.35796329]},
        //         "properties": {
        //             "publicID": "2013p407387",
        //             "time": "2013-05-31T17:36:02.215Z",
        //             "depth": 31.60156250000000000,
        //             "magnitude": 3.76547311499999982,
        //             "locality": "25 km south-east of Amberley",
        //             "mmi": 3,
        //             "quality": "best"
        //         }
        //     }]
        // }
        const quakeSearchPeriod = new Date(this.lastQueryTime.getTime() - this.config.quake_search_time_minutes * 60000);
        if (quakeSearchPeriod < Date.parse(quake.time)) {
            return; // only poll this quake individually if it is not included in the search
        }

        // check if earthquake has expired
        if (!this.cache.hasOwnProperty(quake.id)) {
            this.stopPollingQuake(quake);
            return;
        }

        this.logger.log(`Refreshing quake data for ${quake.id}`);
        request.get(this.urlQuakeQuery + quake.id, (error, response, body) => {
            if (error || response.statusCode !== 200) {
                return this.logger.error('Failed to contact geonet. ' + error);
            }
            const geonetResponse = JSON.parse(body);
            const updatedQuakes = [];
            for (const feature of geonetResponse.features) {
                const earthquake = new Quake(quake.id);
                this.parseCommonFeatureFields(earthquake, feature);
                earthquake.time = feature.properties.time;
                earthquake.quality = feature.properties.quality;

                if (earthquake.quality == 'deleted') {
                    this.logger.log(`Earthquake was deleted ${quake.id}`);
                    this.uncacheQuake(quake);
                    this.stopPollingQuake(quake);
                    this.syncRemovedQuakes([quake.id]);
                    return;
                } else if (!quake.equals(earthquake)) {
                    updatedQuakes.push(quake);
                }

                quake.update(earthquake);

                if (quake.quality == 'best') {
                    this.stopPollingQuake(quake);
                }
            }
            this.syncUpdatedQuakes(updatedQuakes);
        });
    }

    parseCommonFeatureFields(quake, feature) {
        /** @param feature.geometry.coordinates */
        /** @param feature.magnitude */
        [quake.long, quake.lat] = feature.geometry.coordinates;
        quake.mag = feature.properties.magnitude;
        quake.depth = feature.properties.depth;
    }

    cacheQuake(quake) {
        this.cache[quake.id] = quake;
    }

    uncacheQuake(quake) {
        delete this.cache[quake.id];
    }

    stopPollingQuake(quake) {
        if (this.recentQuakes.hasOwnProperty(quake.id)) {
            delete this.recentQuakes[quake.id];
            this.logger.log("Stopped polling quake " + quake.id);
            return true;
        }
        return false;
    }

    refreshRecentQuakes() {
        const recentPeriod = Date.now() - this.config.recent_quake_poll_time_minutes * 60000;
        const quakesToSync = [];
        for (const id in this.cache) {
            const quake = this.cache[id];
            if (Date.parse(quake.time) < recentPeriod) {
                if (this.stopPollingQuake(quake)) {
                    quakesToSync.push(quake);
                }
            } else if (quake.quality !== 'best' && quake.quality !== 'deleted') {
                // only poll quakes that have not been reviewed
                // best/deleted means quake has been reviewed
                // quality property is set after querying the quake individually with refreshQuake()
                this.recentQuakes[quake.id] = quake;
            }
        }
        this.syncUpdatedQuakes(quakesToSync);

        for (const id in this.recentQuakes) {
            this.refreshQuake(this.recentQuakes[id]);
        }
    }

    expireOldEarthquakes() {
        const oldQuakeIds = [];

        let fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - this.config.quake_cache_ttl_days);
        fromDate = fromDate.toISOString();

        for (const id in this.cache) {
            const quake = this.cache[id];
            if (quake.time < fromDate) {
                oldQuakeIds.push(id);
                this.uncacheQuake(quake);
            }
        }

        if (oldQuakeIds.length) {
            this.logger.log('Earthquakes have expired: ' + oldQuakeIds.join(', '));
        }

        this.syncRemovedQuakes(oldQuakeIds);
        return oldQuakeIds;
    }

    onNewQuakes(listener) {
        this.events.on('updated_quakes', listener);
    }

    syncUpdatedQuakes(quakes) {
        if (!quakes.length) {
            return;
        }
        this.events.emit('updated_quakes', quakes);
    }

    onDeletedQuakeIds(listener) {
        this.events.on('removed_quake_ids', listener);
    }

    syncRemovedQuakes(ids) {
        if (!ids.length) {
            return;
        }
        this.events.emit('removed_quake_ids', ids);
    }
}
