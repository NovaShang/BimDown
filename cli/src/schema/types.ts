export type FieldStorage = 'csv' | 'geojson_property';

export interface RawField {
  name: string;
  type: string;
  required?: boolean;
  computed?: boolean;
  storage?: FieldStorage;
  reference?: string;
  values?: string[];
  description?: string;
  default?: unknown;
}

export interface RawSchema {
  name: string;
  abstract?: boolean;
  bases?: string[];
  host_type?: string;
  description?: string;
  fields: RawField[];
}

export interface ResolvedField {
  name: string;
  type: string;
  required: boolean;
  computed: boolean;
  storage: FieldStorage;
  reference?: string;
  values?: string[];
  description?: string;
  default?: unknown;
}

export interface ResolvedTable {
  name: string;
  prefix: string;
  hostType?: string;
  allFields: ResolvedField[];
  csvFields: ResolvedField[];
  geojsonPropertyFields: ResolvedField[];
  computedFields: ResolvedField[];
  description?: string;
}
