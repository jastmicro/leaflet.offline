import L from 'leaflet';
import { getTileUrls, getTileUrl, getTile } from './TileManager';

/**
 * A layer that uses store tiles when available. Falls back to online.
 * Use this layer directly or extend it
 * @class TileLayerOffline
 */
const TileLayerOffline = L.TileLayer.extend(
  /** @lends  TileLayerOffline */ {

    /**
     * Create tile HTMLElement
     * @private
     * @param  {object}   coords x,y,z
     * @param  {Function} done
     * @return {HTMLElement}  img
     */
    createTile(coords, done) {
      let error;
      const tile = L.TileLayer.prototype.createTile.call(this, coords, done);
      const url = tile.src;
      tile.src = '';
      this.setDataUrl(coords)
        .then((dataurl) => {
          tile.src = dataurl;
          done(error, tile);
        })
        .catch(() => {
          tile.src = url;
          done(error, tile);
        });
      return tile;
    },
    /**
     * dataurl from localstorage
     * @private
     * @param {object} coords x,y,z
     * @return {Promise<string>} objecturl
     */
    setDataUrl(coords) {
      return getTile(this._getStorageKey(coords))
        .then((data) => {
          if (data && typeof data === 'object') {
            return URL.createObjectURL(data);
          }
          throw new Error('tile not found in storage');
        });
    },
    /**
     * get key to use for storage
     * @private
     * @param  {string} url url used to load tile
     * @return {string} unique identifier.
     */
    _getStorageKey(coords) {
      return getTileUrl(this._url, {
        ...coords,
        s: this.options.subdomains['0'],
      });
    },
    /**
     * @return {number} Number of simultanous downloads from tile server
     */
    getSimultaneous() {
      return this.options.subdomains.length;
    },
    /**
     * getTileUrls for single zoomlevel
     * @private
     * @param  {object} L.latLngBounds
     * @param  {number} zoom
     * @return {object[]} the tile urls, key, url, x, y, z
     */
    getTileUrls(bounds, zoom) {
      return getTileUrls(this, bounds, zoom);
    },
  });


/**
 * @function L.tileLayer.offline
 * @param  {string} url     [description]
 * @param  {object} options {@link http://leafletjs.com/reference-1.2.0.html#tilelayer}
 * @return {TileLayerOffline}      an instance of TileLayerOffline
 */
L.tileLayer.offline = (url, options) => new TileLayerOffline(url, options);
