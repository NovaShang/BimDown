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
  /** For type tables: the instance tables whose `type_id` may point at this table. */
  type_of?: string[];
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
  /** Instance tables: the type table their `type_id` references (e.g. wall → wall_type). */
  typeTable?: string;
  /** Type tables: the instance tables that may reference them. */
  typeOf?: string[];
  allFields: ResolvedField[];
  csvFields: ResolvedField[];
  geojsonPropertyFields: ResolvedField[];
  computedFields: ResolvedField[];
  description?: string;
}
