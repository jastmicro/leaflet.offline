(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('leaflet'), require('localforage')) :
  typeof define === 'function' && define.amd ? define(['exports', 'leaflet', 'localforage'], factory) :
  (global = global || self, factory(global.LeafletOffline = {}, global.L, global.localforage));
}(this, (function (exports, L, localforage) { 'use strict';

  L = L && L.hasOwnProperty('default') ? L['default'] : L;
  localforage = localforage && localforage.hasOwnProperty('default') ? localforage['default'] : localforage;

  var lf = localforage.createInstance({
    name: 'leaflet_offline',
    version: 1.0,
    size: 4980736,
    storeName: 'tiles',
    description: 'the tile blobs, keyed by url',
  });

  var meta = localforage.createInstance({
    name: 'leaflet_offline_areas',
    version: 1.0,
    size: 4980736,
    storeName: 'area',
    description: 'tile key values as object  ({ key: value, z: z, x: x, y: y}) keyed by {z}_{x}_{y}',
  });

  /**
   *
   * @typedef {Object} tileInfo
   * @property {string} tileInfo.key storage key
   * @property {string} tileInfo.url resolved url
   * @property {string} tileInfo.urlTemplate orig url, used to find tiles per layer
   * @property {string} tileInfo.x x coord of tile
   * @property {string} tileInfo.y y coord of tile
   * @property {string} tileInfo.z tile zoomlevel
   */

  /**
   * @return Promise which resolves to int
   */
  function getStorageLength() {
    return lf.length();
  }

  /**
   * Tip: you can filter the result (eg to get tiles from one resource)
   */
  function getStorageInfo() {
    var result = [];
    return meta
      .iterate(function (value) {
        result.push(value);
      })
      .then(function () { return result; });
  }

  /**
   * resolves to blob
   * @param {string} tileUrl
   */
  function downloadTile(tileUrl) {
    return fetch(tileUrl).then(function (response) {
      if (!response.ok) {
        throw new Error(("Request failed with status " + (response.statusText)));
      }
      return response.blob();
    });
  }
  /**
   * @param {tileInfo}
   * @param {blob} blob
   */
  function saveTile(tileInfo, blob) {
    return lf.removeItem(tileInfo.key).then(function () {
      lf.setItem(tileInfo.key, blob).then(function () {
        var record = Object.assign({}, tileInfo, {createdAt: Date.now()});
        return meta.setItem(tileInfo.key, record);
      });
    });
  }

  /**
   *
   * @param {string} urlTemplate
   * @param {object} data  x, y, z, s
   * @param {string} data.s subdomain
   */
  function getTileUrl(urlTemplate, data) {
    return L.Util.template(urlTemplate, Object.assign({}, data, {r: L.Browser.retina ? '@2x' : ''}));
  }
  /**
   * @param {object} layer leaflet tilelayer
   * @param {object} bounds
   * @param {number} zoom zoomlevel 0-19
   *
   * @return {Array.<tileInfo>}
   */
  function getTileUrls(layer, bounds, zoom) {
    var tiles = [];
    var tileBounds = L.bounds(
      bounds.min.divideBy(layer.getTileSize().x).floor(),
      bounds.max.divideBy(layer.getTileSize().x).floor()
    );
    for (var j = tileBounds.min.y; j <= tileBounds.max.y; j += 1) {
      for (var i = tileBounds.min.x; i <= tileBounds.max.x; i += 1) {
        var tilePoint = new L.Point(i, j);
        var data = { x: i, y: j, z: zoom };
        tiles.push({
          key: getTileUrl(layer._url, Object.assign({}, data, {s: layer.options.subdomains['0']})),
          url: getTileUrl(layer._url, Object.assign({}, data, {s: layer._getSubdomain(tilePoint)})),
          z: zoom,
          x: i,
          y: j,
          urlTemplate: layer._url,
        });
      }
    }

    return tiles;
  }
  /**
   * Get a geojson of tiles from one resource
   * TODO, polygons instead of points, and per per zoomlevel?
   */
  function getStoredTilesAsJson(layer) {
    var featureCollection = {
      type: 'FeatureCollection',
      features: [],
    };
    return getStorageInfo().then(function (results) {
      for (var i = 0; i < results.length; i += 1) {
        if (results[i].urlTemplate !== layer._url) {
          // eslint-disable-next-line no-continue
          continue;
        }
        var topLeftPoint = new L.Point(
          results[i].x * layer.getTileSize().x,
          results[i].y * layer.getTileSize().y
        );
        var bottomRightPoint = new L.Point(
          topLeftPoint.x + layer.getTileSize().x,
          topLeftPoint.y + layer.getTileSize().y
        );

        var topLeftlatlng = L.CRS.EPSG3857.pointToLatLng(topLeftPoint, results[i].z);
        var botRightlatlng = L.CRS.EPSG3857.pointToLatLng(bottomRightPoint, results[i].z);
        featureCollection.features.push({
          type: 'Feature',
          properties: results[i],
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [topLeftlatlng.lng, topLeftlatlng.lat],
                [botRightlatlng.lng, topLeftlatlng.lat],
                [botRightlatlng.lng, botRightlatlng.lat],
                [topLeftlatlng.lng, botRightlatlng.lat],
                [topLeftlatlng.lng, topLeftlatlng.lat] ] ],
          },
        });
      }

      return featureCollection;
    });
  }

  /**
   * Remove tile by key
   * @param {string} key
   */
  function removeTile(key) {
    lf.removeItem(key).then(function () { return meta.removeItem(key); });
  }

  /**
   * Remove everything
   *
   * @return Promise
   */
  function truncate() {
    return lf.clear().then(function () { return meta.clear(); });
  }

  /**
   * A layer that uses store tiles when available. Falls back to online.
   * Use this layer directly or extend it
   * @class TileLayerOffline
   */
  var TileLayerOffline = L.TileLayer.extend(
    /** @lends  TileLayerOffline */ {
      /**
       * Create tile HTMLElement
       * @private
       * @param  {object}   coords x,y,z
       * @param  {Function} done
       * @return {HTMLElement}  img
       */
      createTile: function createTile(coords, done) {
        var error;
        var tile = L.TileLayer.prototype.createTile.call(this, coords, done);
        var url = tile.src;
        tile.src = '';
        this.setDataUrl(coords)
          .then(function (dataurl) {
            tile.src = dataurl;
            done(error, tile);
          })
          .catch(function () {
            tile.src = url;
            done(error, tile);
          });
        return tile;
      },
      /**
       * dataurl from localstorage
       * @param {object} coords x,y,z
       * @return {Promise} resolves to base64 url
       */
      setDataUrl: function setDataUrl(coords) {
        var this$1 = this;

        return new Promise(function (resolve, reject) {
          lf
            .getItem(this$1._getStorageKey(coords))
            .then(function (data) {
              if (data && typeof data === 'object') {
                resolve(URL.createObjectURL(data));
              } else {
                reject();
              }
            })
            .catch(function (e) {
              reject(e);
            });
        });
      },
      /**
       * get key to use for storage
       * @private
       * @param  {string} url url used to load tile
       * @return {string} unique identifier.
       */
      _getStorageKey: function _getStorageKey(coords) {
        return getTileUrl(this._url, Object.assign({}, coords, {s: this.options.subdomains['0']}));
      },
      /**
       * @return {number} Number of simultanous downloads from tile server
       */
      getSimultaneous: function getSimultaneous() {
        return this.options.subdomains.length;
      },
      /**
       * getTileUrls for single zoomlevel
       * @param  {object} L.latLngBounds
       * @param  {number} zoom
       * @return {object[]} the tile urls, key, url, x, y, z
       */
      getTileUrls: function getTileUrls$1(bounds, zoom) {
        return getTileUrls(this, bounds, zoom);
      },
    }
  );

  /**
   * Tiles removed event
   * @event storagesize
   * @memberof TileLayerOffline
   * @type {object}
   */

  /**
   * Start saving tiles
   * @event savestart
   * @memberof TileLayerOffline
   * @type {object}
   */

  /**
   * Tile fetched
   * @event loadtileend
   * @memberof TileLayerOffline
   * @type {object}
   */

  /**
   * All tiles fetched
   * @event loadend
   * @memberof TileLayerOffline
   * @type {object}
   */

  /**
   * Tile saved
   * @event savetileend
   * @memberof TileLayerOffline
   * @type {object}
   */

  /**
   * All tiles saved
   * @event saveend
   * @memberof TileLayerOffline
   * @type {object}
   */

  /**
   * Tile removed
   * @event tilesremoved
   * @memberof TileLayerOffline
   * @type {object}
   */

  /**
   * @function L.tileLayer.offline
   * @param  {string} url     [description]
   * @param  {object} options {@link http://leafletjs.com/reference-1.2.0.html#tilelayer}
   * @return {TileLayerOffline}      an instance of TileLayerOffline
   */
  L.tileLayer.offline = function (url, options) { return new TileLayerOffline(url, options); };

  /**
   * Status of ControlSaveTiles, keeps info about process during downloading
   * ans saving tiles. Used internal and as object for events.
   * @typedef {Object} ControlStatus
   * @property {number} storagesize total number of saved tiles.
   * @property {number} lengthToBeSaved number of tiles that will be saved in db
   * during current process
   * @property {number} lengthSaved number of tiles saved during current process
   * @property {number} lengthLoaded number of tiles loaded during current process
   * @property {array} _tilesforSave tiles waiting for processing
   */

  /**
   * Shows control on map to save tiles
   * @class ControlSaveTiles
   *
   * @property {ControlStatus} status
   */
  var ControlSaveTiles = L.Control.extend(
    /** @lends ControlSaveTiles */ {
      options: {
        position: 'topleft',
        saveText: '+',
        rmText: '-',
        maxZoom: 19,
        saveWhatYouSee: false,
        bounds: null,
        confirm: null,
        confirmRemoval: null,
      },
      status: {
        storagesize: null,
        lengthToBeSaved: null,
        lengthSaved: null,
        lengthLoaded: null,
        _tilesforSave: null,
      },
      /**
       * @private
       * @param  {Object} baseLayer
       * @param  {Object} options
       * @return {void}
       */
      initialize: function initialize(baseLayer, options) {
        this._baseLayer = baseLayer;
        this.setStorageSize();
        L.setOptions(this, options);
      },
      /**
       * Set storagesize prop on object init
       * @param {Function} [callback] receives arg number of saved files
       * @private
       */
      setStorageSize: function setStorageSize(callback) {
        var this$1 = this;

        if (this.status.storagesize) {
          callback(this.status.storagesize);
          return;
        }
        getStorageLength()
          .then(function (numberOfKeys) {
            this$1.status.storagesize = numberOfKeys;
            this$1._baseLayer.fire('storagesize', this$1.status);
            if (callback) {
              callback(numberOfKeys);
            }
          })
          .catch(function (err) {
            callback(0);
            throw err;
          });
      },
      /**
       * get number of saved files
       * @param  {Function} callback [description]
       * @private
       */
      getStorageSize: function getStorageSize(callback) {
        this.setStorageSize(callback);
      },
      /**
       * Change baseLayer
       * @param {TileLayerOffline} layer
       */
      setLayer: function setLayer(layer) {
        this._baseLayer = layer;
      },
      /**
       * Update a config option
       * @param {string} name
       * @param {mixed} value
       */
      setOption: function setOption(name, value) {
        this.options[name] = value;
      },
      onAdd: function onAdd() {
        var container = L.DomUtil.create('div', 'savetiles leaflet-bar');
        var ref = this;
        var options = ref.options;
        this._createButton(options.saveText, 'savetiles', container, this._saveTiles);
        this._createButton(options.rmText, 'rmtiles', container, this._rmTiles);
        return container;
      },
      _createButton: function _createButton(html, className, container, fn) {
        var link = L.DomUtil.create('a', className, container);
        link.innerHTML = html;
        link.href = '#';

        L.DomEvent.on(link, 'mousedown dblclick', L.DomEvent.stopPropagation)
          .on(link, 'click', L.DomEvent.stop)
          .on(link, 'click', fn, this)
          .on(link, 'click', this._refocusOnMap, this);
        // TODO enable disable on layer change map

        return link;
      },
      /**
       * starts processing tiles
       * @private
       * @return {void}
       */
      _saveTiles: function _saveTiles() {
        var this$1 = this;

        var bounds;
        var tiles = [];
        // minimum zoom to prevent the user from saving the whole world
        var minZoom = 5;
        // current zoom or zoom options
        var zoomlevels = [];

        if (this.options.saveWhatYouSee) {
          var currentZoom = this._map.getZoom();
          if (currentZoom < minZoom) {
            throw new Error("It's not possible to save with zoom below level 5.");
          }
          var ref = this.options;
          var maxZoom = ref.maxZoom;

          for (var zoom = currentZoom; zoom <= maxZoom; zoom += 1) {
            zoomlevels.push(zoom);
          }
        } else {
          zoomlevels = this.options.zoomlevels || [this._map.getZoom()];
        }

        var latlngBounds = this.options.bounds || this._map.getBounds();

        for (var i = 0; i < zoomlevels.length; i += 1) {
          bounds = L.bounds(
            this._map.project(latlngBounds.getNorthWest(), zoomlevels[i]),
            this._map.project(latlngBounds.getSouthEast(), zoomlevels[i])
          );
          tiles = tiles.concat(this._baseLayer.getTileUrls(bounds, zoomlevels[i]));
        }
        this._resetStatus(tiles);
        var succescallback = function () {
          this$1._baseLayer.fire('savestart', this$1.status);
          var subdlength = this$1._baseLayer.getSimultaneous();
          // TODO!
          // storeTiles(tiles, subdlength);
          for (var i = 0; i < subdlength; i += 1) {
            this$1._loadTile();
          }
        };
        if (this.options.confirm) {
          this.options.confirm(this.status, succescallback);
        } else {
          succescallback();
        }
      },
      /**
       * set status prop on save init
       * @param {string[]} tiles [description]
       * @private
       */
      _resetStatus: function _resetStatus(tiles) {
        this.status = {
          lengthLoaded: 0,
          lengthToBeSaved: tiles.length,
          lengthSaved: 0,
          _tilesforSave: tiles,
        };
      },
      /**
       * Loop over status._tilesforSave prop till all tiles are downloaded
       * Calls _saveTile for each download
       * @private
       * @return {void}
       */
      _loadTile: function _loadTile() {
        var self = this;
        var tile = self.status._tilesforSave.shift();
        downloadTile(tile.url).then(function (blob) {
          self.status.lengthLoaded += 1;
          self._saveTile(tile, blob);
          if (self.status._tilesforSave.length > 0) {
            self._loadTile();
            self._baseLayer.fire('loadtileend', self.status);
          } else {
            self._baseLayer.fire('loadtileend', self.status);
            if (self.status.lengthLoaded === self.status.lengthToBeSaved) {
              self._baseLayer.fire('loadend', self.status);
            }
          }
        });
      },
      /**
       * [_saveTile description]
       * @private
       * @param  {object} tileInfo save key
       * @param {string} tileInfo.key
       * @param {string} tileInfo.url
       * @param {string} tileInfo.x
       * @param {string} tileInfo.y
       * @param {string} tileInfo.z
       * @param  {blob} blob    [description]
       * @return {void}         [description]
       */
      _saveTile: function _saveTile(tileInfo, blob) {
        var self = this;
        saveTile(tileInfo, blob)
          .then(function () {
            self.status.lengthSaved += 1;
            self._baseLayer.fire('savetileend', self.status);
            if (self.status.lengthSaved === self.status.lengthToBeSaved) {
              self._baseLayer.fire('saveend', self.status);
              self.setStorageSize();
            }
          })
          .catch(function (err) {
            throw new Error(err);
          });
      },
      _rmTiles: function _rmTiles() {
        var self = this;
        var successCallback = function () {
          truncate().then(function () {
            self.status.storagesize = 0;
            self._baseLayer.fire('tilesremoved');
            self._baseLayer.fire('storagesize', self.status);
          });
        };
        if (this.options.confirmRemoval) {
          this.options.confirmRemoval(this.status, successCallback);
        } else {
          successCallback();
        }
      },
    }
  );
  /**
   * @function L.control.savetiles
   * @param  {object} baseLayer     {@link http://leafletjs.com/reference-1.2.0.html#tilelayer}
   * @property {Object} options
   * @property {string} [options.position] default topleft
   * @property {string} [options.saveText] html for save button, default +
   * @property {string} [options.rmText] html for remove button, deflault -
   * @property {number} [options.maxZoom] maximum zoom level that will be reached
   * when saving tiles with saveWhatYouSee. Default 19
   * @property {boolean} [options.saveWhatYouSee] save the tiles that you see
   * on screen plus deeper zooms, ignores zoomLevels options. Default false
   * @property {function} [options.confirm] function called before confirm, default null.
   * Args of function are ControlStatus and callback.
   * @property {function} [options.confirmRemoval] function called before confirm, default null
   * @return {ControlSaveTiles}
   */
  L.control.savetiles = function (baseLayer, options) { return new ControlSaveTiles(baseLayer, options); };

  exports.getStorageInfo = getStorageInfo;
  exports.getStorageLength = getStorageLength;
  exports.getStoredTilesAsJson = getStoredTilesAsJson;
  exports.removeTile = removeTile;
  exports.truncate = truncate;

  Object.defineProperty(exports, '__esModule', { value: true });

})));
