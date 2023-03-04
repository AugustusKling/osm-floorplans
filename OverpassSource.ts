import { FeatureLoader } from 'ol/featureloader';
import { GeoJSON } from 'ol/format';
import { transformExtent } from 'ol/proj';
import VectorSource, { Options } from 'ol/source/Vector';
import osmtogeojson from 'osmtogeojson';

export class OverpassSource extends VectorSource {
  private concurrentRequests = 0;
  private queryTemplate = `[out:json][timeout:25];
  // gather results
  (
    nwr[indoor][level][!building]({{bbox}});
    nw[door][level][!building]({{bbox}});
    nw[entrance][level][!building]({{bbox}});
    nwr[shop][level][!building]({{bbox}});
    nwr[amenity][level][!building]({{bbox}});
  ) -> .indoor;
  (nwr[indoor=room]({{bbox}});nwr[indoor=corridor]({{bbox}});) -> .rooms;
  .rooms >; is_in;nwr(pivot._)[building]({{bbox}}) -> .buildings;
  // print results
  (.indoor; .buildings;); out body;
  >;
  out skel qt;`;

  private geoJsonFormat = new GeoJSON();

  public constructor(options: Options) {
    super({
      ...options,
      loader: options.loader || (() => {}),
    });
    if (!options.loader) {
      this.setLoader(this.loader);
    }
  }

  loader: FeatureLoader = async (
    extent,
    resolution,
    projection,
    success,
    failure
  ): Promise<void> => {
    const epsg4326Extent = transformExtent(extent, projection, 'EPSG:4326');

    const query = this.queryTemplate.replace(
      /\{\{bbox\}\}/g,
      epsg4326Extent[1] +
        ',' +
        Math.max(epsg4326Extent[0], -180) +
        ',' +
        epsg4326Extent[3] +
        ',' +
        Math.min(epsg4326Extent[2], 180)
    );
    try {
      const cache = await caches.open('osm-floorplans');
      const request = new Request('https://overpass.kumi.systems/api/interpreter?data='+encodeURIComponent(query));
      let response = await cache.match(request);
      if (response) {
        const age = new Date().getTime() - new Date(response.headers.get('x-date')).getTime();
        // Ignore everything older than 1 week.
        if (age > 1000*60*60*24*7) {
          await cache.delete(request);
          response = undefined;
        }
      }
      if (!response) {
        if (this.concurrentRequests > 30) {
          console.error('Too many concurrent Overpass requests.');
          this.removeLoadedExtent(extent);
          failure();
          return;
        } else {
          this.concurrentRequests = this.concurrentRequests + 1;
        }
        const postRequest = new Request('https://overpass.kumi.systems/api/interpreter', {
          method: 'POST',
          body: new URLSearchParams({
            data: query,
          })
        });
        const response = await fetch(postRequest);
        this.concurrentRequests = this.concurrentRequests - 1;
        if (response.status !== 200) {
          throw new Error('Overpass failure response.');
        }
        await cache.put(request, new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: {
            'content-type': 'application/json',
            'x-date': new Date().toISOString()
          }
        }));
      }
      response = await cache.match(request);
      const responseBody = await response.json();
      const geoJson = osmtogeojson(responseBody, {
        flatProperties: true,
      });
      const features = this.geoJsonFormat.readFeatures(geoJson, {
        featureProjection: projection,
      });
      this.addFeatures(features);
      success(features);
    } catch (e) {
      console.error(e);
      this.removeLoadedExtent(extent);
      failure();
    }
  };
}
