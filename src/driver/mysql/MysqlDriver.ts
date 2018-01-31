import {Driver} from "../Driver";
import {ConnectionIsNotSetError} from "../../error/ConnectionIsNotSetError";
import {DriverPackageNotInstalledError} from "../../error/DriverPackageNotInstalledError";
import {DriverUtils} from "../DriverUtils";
import {MysqlQueryRunner} from "./MysqlQueryRunner";
import {ObjectLiteral} from "../../common/ObjectLiteral";
import {ColumnMetadata} from "../../metadata/ColumnMetadata";
import {DateUtils} from "../../util/DateUtils";
import {PlatformTools} from "../../platform/PlatformTools";
import {Connection} from "../../connection/Connection";
import {RdbmsSchemaBuilder} from "../../schema-builder/RdbmsSchemaBuilder";
import {MysqlConnectionOptions} from "./MysqlConnectionOptions";
import {MappedColumnTypes} from "../types/MappedColumnTypes";
import {ColumnType} from "../types/ColumnTypes";
import {DataTypeDefaults} from "../types/DataTypeDefaults";
import {TableColumn} from "../../schema-builder/schema/TableColumn";
import {RandomGenerator} from "../../util/RandomGenerator";
import {MysqlConnectionCredentialsOptions} from "./MysqlConnectionCredentialsOptions";

/**
 * Organizes communication with MySQL DBMS.
 */
export class MysqlDriver implements Driver {

    // -------------------------------------------------------------------------
    // Public Properties
    // -------------------------------------------------------------------------

    /**
     * Connection used by driver.
     */
    connection: Connection;

    /**
     * Mysql underlying library.
     */
    mysql: any;

    /**
     * Connection pool.
     * Used in non-replication mode.
     */
    pool: any;

    /**
     * Pool cluster used in replication mode.
     */
    poolCluster: any;

    // -------------------------------------------------------------------------
    // Public Implemented Properties
    // -------------------------------------------------------------------------

    /**
     * Connection options.
     */
    options: MysqlConnectionOptions;

    /**
     * Master database used to perform all write queries.
     */
    database?: string;

    /**
     * Indicates if replication is enabled.
     */
    isReplicated: boolean = false;

    /**
     * Indicates if tree tables are supported by this driver.
     */
    treeSupport = true;

    /**
     * Gets list of supported column data types by a driver.
     *
     * @see https://www.tutorialspoint.com/mysql/mysql-data-types.htm
     * @see https://dev.mysql.com/doc/refman/5.7/en/data-types.html
     */
    supportedDataTypes: ColumnType[] = [
        "int",
        "tinyint",
        "smallint",
        "mediumint",
        "bigint",
        "float",
        "double",
        "decimal",
        "date",
        "datetime",
        "timestamp",
        "time",
        "year",
        "char",
        "varchar",
        "blob",
        "text",
        "tinyblob",
        "tinytext",
        "mediumblob",
        "mediumtext",
        "longblob",
        "longtext",
        "enum",
        "json"
    ];

    /**
     * Gets list of column data types that support length by a driver.
     */
    withLengthColumnTypes: ColumnType[] = [
        "int",
        "tinyint",
        "smallint",
        "mediumint",
        "bigint",
        "char",
        "varchar",
        "blob",
        "text"
    ];

    /**
     * ORM has special columns and we need to know what database column types should be for those columns.
     * Column types are driver dependant.
     */
    mappedDataTypes: MappedColumnTypes = {
        createDate: "datetime",
        createDatePrecision: 6,
        createDateDefault: "CURRENT_TIMESTAMP(6)",
        updateDate: "datetime",
        updateDatePrecision: 6,
        updateDateDefault: "CURRENT_TIMESTAMP(6)",
        version: "int",
        treeLevel: "int",
        migrationName: "varchar",
        migrationTimestamp: "bigint",
        cacheId: "int",
        cacheIdentifier: "varchar",
        cacheTime: "bigint",
        cacheDuration: "int",
        cacheQuery: "text",
        cacheResult: "text",
    };

    /**
     * Default values of length, precision and scale depends on column data type.
     * Used in the cases when length/precision/scale is not specified by user.
     */
    dataTypeDefaults: DataTypeDefaults = {
        varchar: { length: 255 },
        int: { length: 11 },
        tinyint: { length: 4 },
        smallint: { length: 5 },
        mediumint: { length: 9 },
        bigint: { length: 20 },
        year: { length: 4 }
    };

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(connection: Connection) {
        this.connection = connection;
        this.options = connection.options as MysqlConnectionOptions;
        this.isReplicated = this.options.replication ? true : false;

        // load mysql package
        this.loadDependencies();

        // validate options to make sure everything is set
        // todo: revisit validation with replication in mind
        // if (!(this.options.host || (this.options.extra && this.options.extra.socketPath)) && !this.options.socketPath)
        //     throw new DriverOptionNotSetError("socketPath and host");
        // if (!this.options.username)
        //     throw new DriverOptionNotSetError("username");
        // if (!this.options.database)
        //     throw new DriverOptionNotSetError("database");
        // todo: check what is going on when connection is setup without database and how to connect to a database then?
        // todo: provide options to auto-create a database if it does not exist yet
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Performs connection to the database.
     */
    async connect(): Promise<void> {

        if (this.options.replication) {
            this.poolCluster = this.mysql.createPoolCluster(this.options.replication);
            this.options.replication.slaves.forEach((slave, index) => {
                this.poolCluster.add("SLAVE" + index, this.createConnectionOptions(this.options, slave));
            });
            this.poolCluster.add("MASTER", this.createConnectionOptions(this.options, this.options.replication.master));
            this.database = this.options.replication.master.database;

        } else {
            this.pool = await this.createPool(this.createConnectionOptions(this.options, this.options));
            this.database = this.options.database;
        }
    }

    /**
     * Makes any action after connection (e.g. create extensions in Postgres driver).
     */
    afterConnect(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Closes connection with the database.
     */
    async disconnect(): Promise<void> {
        if (!this.poolCluster && !this.pool)
            return Promise.reject(new ConnectionIsNotSetError("mysql"));

        if (this.poolCluster) {
            return new Promise<void>((ok, fail) => {
                this.poolCluster.end((err: any) => err ? fail(err) : ok());
                this.poolCluster = undefined;
            });
        }
        if (this.pool) {
            return new Promise<void>((ok, fail) => {
                this.pool.end((err: any) => {
                    if (err) return fail(err);
                    this.pool = undefined;
                    ok();
                });
            });
        }
    }

    /**
     * Creates a schema builder used to build and sync a schema.
     */
    createSchemaBuilder() {
        return new RdbmsSchemaBuilder(this.connection);
    }

    /**
     * Creates a query runner used to execute database queries.
     */
    createQueryRunner(mode: "master"|"slave" = "master") {
        return new MysqlQueryRunner(this, mode);
    }

    /**
     * Replaces parameters in the given sql with special escaping character
     * and an array of parameter names to be passed to a query.
     */
    escapeQueryWithParameters(sql: string, parameters: ObjectLiteral): [string, any[]] {
        if (!parameters || !Object.keys(parameters).length)
            return [sql, []];

        const escapedParameters: any[] = [];
        const keys = Object.keys(parameters).map(parameter => "(:" + parameter + "\\b)").join("|");
        sql = sql.replace(new RegExp(keys, "g"), (key: string) => {
            const value = parameters[key.substr(1)];
            if (value instanceof Function) {
                return value();

            } else {
                escapedParameters.push(parameters[key.substr(1)]);
                return "?";
            }
        }); // todo: make replace only in value statements, otherwise problems
        return [sql, escapedParameters];
    }

    /**
     * Escapes a column name.
     */
    escape(columnName: string): string {
        return "`" + columnName + "`";
    }

    /**
     * Prepares given value to a value to be persisted, based on its column type and metadata.
     */
    preparePersistentValue(value: any, columnMetadata: ColumnMetadata): any {
        if (columnMetadata.transformer)
            value = columnMetadata.transformer.to(value);

        if (value === null || value === undefined)
            return value;

        if (columnMetadata.type === Boolean) {
            return value === true ? 1 : 0;

        } else if (columnMetadata.type === "date") {
            return DateUtils.mixedDateToDateString(value);

        } else if (columnMetadata.type === "time") {
            return DateUtils.mixedDateToTimeString(value);

        } else if (columnMetadata.type === "json") {
            return JSON.stringify(value);

        } else if (columnMetadata.type === "datetime" || columnMetadata.type === Date) {
            return DateUtils.mixedDateToDate(value, columnMetadata.toUtc);

        } else if (columnMetadata.isGenerated && columnMetadata.generationStrategy === "uuid" && !value) {
            return RandomGenerator.uuid4();

        } else if (columnMetadata.type === "simple-array") {
            return DateUtils.simpleArrayToString(value);

        } else if (columnMetadata.type === "simple-json") {
            return DateUtils.simpleJsonToString(value);
        }

        return value;
    }

    /**
     * Prepares given value to a value to be persisted, based on its column type or metadata.
     */
    prepareHydratedValue(value: any, columnMetadata: ColumnMetadata): any {
        if (columnMetadata.transformer)
            value = columnMetadata.transformer.from(value);

        if (value === null || value === undefined)
            return value;

        if (columnMetadata.type === Boolean) {
            return value ? true : false;

        } else if (columnMetadata.type === "datetime" || columnMetadata.type === Date) {
            return DateUtils.normalizeHydratedDate(value);

        } else if (columnMetadata.type === "date") {
            return DateUtils.mixedDateToDateString(value);

        } else if (columnMetadata.type === "json") {
            return typeof value === "string" ? JSON.parse(value) : value;

        } else if (columnMetadata.type === "time") {
            return DateUtils.mixedTimeToString(value);

        } else if (columnMetadata.type === "simple-array") {
            return DateUtils.stringToSimpleArray(value);

        } else if (columnMetadata.type === "simple-json") {
            return DateUtils.stringToSimpleJson(value);
        }

        return value;
    }

    /**
     * Creates a database type from a given column metadata.
     */
    normalizeType(column: { type: ColumnType, length?: number | string, precision?: number, scale?: number }): string {
        if (column.type === Number || column.type === "integer") {
            return "int";

        } else if (column.type === String) {
            return "varchar";

        } else if (column.type === Date) {
            return "datetime";

        } else if ((column.type as any) === Buffer) {
            return "blob";

        } else if (column.type === Boolean) {
            return "tinyint";

        } else if (column.type === "uuid") {
            return "varchar";

        } else if (column.type === "simple-array") {
            return "text";

        } else if (column.type === "simple-json") {
            return "text";

        } else {
            return column.type as string || "";
        }
    }

    /**
     * Normalizes "default" value of the column.
     */
    normalizeDefault(column: ColumnMetadata): string {
        if (typeof column.default === "number") {
            return "" + column.default;

        } else if (typeof column.default === "boolean") {
            return column.default === true ? "1" : "0";

        } else if (typeof column.default === "function") {
            return column.default();

        } else if (typeof column.default === "string") {
            return `'${column.default}'`;

        } else {
            return column.default;
        }
    }

    /**
     * Normalizes "isUnique" value of the column.
     */
    normalizeIsUnique(column: ColumnMetadata): boolean {
        return column.isUnique ||
            !!column.entityMetadata.indices.find(index => index.isUnique && index.columns.length === 1 && index.columns[0] === column);
    }

    /**
     * Calculates column length taking into account the default length values.
     */
    getColumnLength(column: ColumnMetadata): string {

        if (column.length)
            return column.length;

        const normalizedType = this.normalizeType(column) as string;
        if (this.dataTypeDefaults && this.dataTypeDefaults[normalizedType] && this.dataTypeDefaults[normalizedType].length)
            return this.dataTypeDefaults[normalizedType].length!.toString();

        return "";
    }

    createFullType(column: TableColumn): string {
        let type = column.type;

        if (column.length) {
            type += "(" + column.length + ")";
        } else if (column.precision && column.scale) {
            type += "(" + column.precision + "," + column.scale + ")";
        } else if (column.precision) {
            type +=  "(" + column.precision + ")";
        } else if (column.scale) {
            type +=  "(" + column.scale + ")";
        } else  if (this.dataTypeDefaults && this.dataTypeDefaults[column.type] && this.dataTypeDefaults[column.type].length) {
            type +=  "(" + this.dataTypeDefaults[column.type].length!.toString() + ")";
        }

        if (column.isArray)
            type += " array";

        return type;
    }

    /**
     * Obtains a new database connection to a master server.
     * Used for replication.
     * If replication is not setup then returns default connection's database connection.
     */
    obtainMasterConnection(): Promise<any> {
        return new Promise<any>((ok, fail) => {
            if (this.poolCluster) {
                this.poolCluster.getConnection("MASTER", (err: any, dbConnection: any) => {
                    err ? fail(err) : ok(dbConnection);
                });

            } else if (this.pool) {
                this.pool.getConnection((err: any, dbConnection: any) => {
                    err ? fail(err) : ok(dbConnection);
                });
            } else {
                fail(new Error(`Connection is not established with mysql database`));
            }
        });
    }

    /**
     * Obtains a new database connection to a slave server.
     * Used for replication.
     * If replication is not setup then returns master (default) connection's database connection.
     */
    obtainSlaveConnection(): Promise<any> {
        if (!this.poolCluster)
            return this.obtainMasterConnection();

        return new Promise<any>((ok, fail) => {
            this.poolCluster.getConnection("SLAVE*", (err: any, dbConnection: any) => {
                err ? fail(err) : ok(dbConnection);
            });
        });
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Loads all driver dependencies.
     */
    protected loadDependencies(): void {
        try {
            this.mysql = PlatformTools.load("mysql");  // try to load first supported package

        } catch (e) {
            try {
                this.mysql = PlatformTools.load("mysql2"); // try to load second supported package

            } catch (e) {
                throw new DriverPackageNotInstalledError("Mysql", "mysql");
            }
        }
    }

    /**
     * Creates a new connection pool for a given database credentials.
     */
    protected createConnectionOptions(options: MysqlConnectionOptions, credentials: MysqlConnectionCredentialsOptions): Promise<any> {

        credentials = Object.assign(credentials, DriverUtils.buildDriverOptions(credentials)); // todo: do it better way

        // build connection options for the driver
        return Object.assign({}, {
            charset: options.charset,
            timezone: options.timezone,
            connectTimeout: options.connectTimeout,
            insecureAuth: options.insecureAuth,
            supportBigNumbers: options.supportBigNumbers,
            bigNumberStrings: options.bigNumberStrings,
            dateStrings: options.dateStrings,
            debug: options.debug,
            trace: options.trace,
            multipleStatements: options.multipleStatements,
            flags: options.flags
        }, {
            host: credentials.host,
            user: credentials.username,
            password: credentials.password,
            database: credentials.database,
            port: credentials.port,
            ssl: options.ssl
        }, options.extra || {});
    }

    /**
     * Creates a new connection pool for a given database credentials.
     */
    protected createPool(connectionOptions: any): Promise<any> {

        // create a connection pool
        const pool = this.mysql.createPool(connectionOptions);

        // make sure connection is working fine
        return new Promise<void>((ok, fail) => {
            // (issue #610) we make first connection to database to make sure if connection credentials are wrong
            // we give error before calling any other method that creates actual query runner
            pool.getConnection((err: any, connection: any) => {
                if (err)
                    return pool.end(() => fail(err));

                connection.release();
                ok(pool);
            });
        });
    }

}
