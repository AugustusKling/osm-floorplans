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
    nw["indoor"]["level"]({{bbox}});
    nw["door"]["level"]({{bbox}});
  ) -> .indoor;
  .indoor >; is_in;nwr(pivot._)[building]({{bbox}}) -> .buildings;
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
    if (this.concurrentRequests > 30) {
      throw new Error('Too many Overpass requests.');
    } else {
      this.concurrentRequests = this.concurrentRequests + 1;
    }

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
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({
        data: query,
      }),
    });
    this.concurrentRequests = this.concurrentRequests - 1;
    try {
      const responseBody = await response.json();
      const geoJson = osmtogeojson(responseBody, {
        flatProperties: true,
      });
      const features = this.geoJsonFormat.readFeatures(geoJson, {
        featureProjection: projection,
      });
      this.addFeatures(features);
      success(features);
    } catch {
      this.removeLoadedExtent(extent);
      failure();
    }
  };
}
