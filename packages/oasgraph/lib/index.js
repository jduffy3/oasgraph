"use strict";
// Copyright IBM Corp. 2018. All Rights Reserved.
// Node module: oasgraph
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const graphql_1 = require("graphql");
// Imports:
const schema_builder_1 = require("./schema_builder");
const resolver_builder_1 = require("./resolver_builder");
const GraphQLTools = require("./graphql_tools");
const preprocessor_1 = require("./preprocessor");
const Oas3Tools = require("./oas_3_tools");
const auth_builder_1 = require("./auth_builder");
const debug_1 = require("debug");
const utils_1 = require("./utils");
const log = debug_1.default('translation');
/**
 * Creates a GraphQL interface from the given OpenAPI Specification (2 or 3).
 */
function createGraphQlSchema(spec, options) {
    return __awaiter(this, void 0, void 0, function* () {
        if (typeof options === 'undefined') {
            options = {};
        }
        // Setting default options
        options.strict = typeof options.strict === 'boolean'
            ? options.strict
            : false;
        options.viewer = typeof options.viewer === 'boolean'
            ? options.viewer
            : true;
        options.sendOAuthTokenInQuery = typeof options.sendOAuthTokenInQuery === 'boolean'
            ? options.sendOAuthTokenInQuery
            : false;
        options.fillEmptyResponses = typeof options.fillEmptyResponses === 'boolean'
            ? options.fillEmptyResponses
            : false;
        options.operationIdFieldNames = typeof options.operationIdFieldNames === 'boolean'
            ? options.operationIdFieldNames
            : false;
        options['report'] = {
            warnings: [],
            numOps: 0,
            numOpsQuery: 0,
            numOpsMutation: 0,
            numQueriesCreated: 0,
            numMutationsCreated: 0
        };
        let oass;
        if (Array.isArray(spec)) {
            /**
             * Convert all non-OAS 3.0.x into OAS 3.0.x
             */
            oass = yield Promise.all(spec.map((ele) => {
                return Oas3Tools.getValidOAS3(ele);
            }));
        }
        else {
            /**
             * Check if the spec is a valid OAS 3.0.x
             * If the spec is OAS 2.0, attempt to translate it into 3.0.x, then try to
             * translate the spec into a GraphQL schema
             */
            oass = [yield Oas3Tools.getValidOAS3(spec)];
        }
        let { schema, report } = yield translateOpenApiToGraphQL(oass, options);
        return {
            schema,
            report
        };
    });
}
exports.createGraphQlSchema = createGraphQlSchema;
/**
 * Creates a GraphQL interface from the given OpenAPI Specification 3.0.x
 */
function translateOpenApiToGraphQL(oass, { strict, headers, qs, viewer, tokenJSONpath, sendOAuthTokenInQuery, fillEmptyResponses, baseUrl, operationIdFieldNames, report, requestOptions }) {
    return __awaiter(this, void 0, void 0, function* () {
        let options = {
            headers,
            qs,
            viewer,
            tokenJSONpath,
            strict,
            sendOAuthTokenInQuery,
            fillEmptyResponses,
            baseUrl,
            operationIdFieldNames,
            report,
            requestOptions
        };
        log(`Options: ${JSON.stringify(options)}`);
        /**
         * Extract information from the OASs and put it inside a data structure that
         * is easier for OASGraph to use
         */
        let data = preprocessor_1.preprocessOas(oass, options);
        /**
         * Create GraphQL fields for every operation and structure them based on their
         * characteristics (query vs. mutation, auth vs. non-auth).
         */
        let queryFields = {};
        let mutationFields = {};
        let authQueryFields = {};
        let authMutationFields = {};
        Object.entries(data.operations)
            /**
             * Start with operations that return objects rather than arrays
             *
             * First, build up the GraphQL object so that operations that return arrays
             * can use them
             */
            .sort(([op1Id, op1], [op2Id, op2]) => sortOperations(op1, op2))
            .forEach(([operationId, operation]) => {
            log(`Process operation "${operationId}"...`);
            let field = getFieldForOperation(operation, options.baseUrl, data, oass, requestOptions);
            if (!operation.isMutation) {
                let fieldName = Oas3Tools.uncapitalize(operation.responseDefinition.otName);
                if (operation.inViewer) {
                    for (let securityRequirement of operation.securityRequirements) {
                        if (typeof authQueryFields[securityRequirement] !== 'object') {
                            authQueryFields[securityRequirement] = {};
                        }
                        // Avoid overwriting fields that return the same data:
                        if (fieldName in authQueryFields[securityRequirement] ||
                            operationIdFieldNames) {
                            fieldName = Oas3Tools.beautifyAndStore(operationId, data.saneMap);
                        }
                        if (fieldName in authQueryFields[securityRequirement]) {
                            utils_1.handleWarning({
                                typeKey: 'DUPLICATE_FIELD_NAME',
                                culprit: fieldName,
                                data,
                                log
                            });
                        }
                        authQueryFields[securityRequirement][fieldName] = field;
                    }
                }
                else {
                    // Avoid overwriting fields that return the same data:
                    if (fieldName in queryFields ||
                        operationIdFieldNames) {
                        fieldName = Oas3Tools.beautifyAndStore(operationId, data.saneMap);
                    }
                    if (fieldName in queryFields) {
                        utils_1.handleWarning({
                            typeKey: 'DUPLICATE_FIELD_NAME',
                            culprit: fieldName,
                            data,
                            log
                        });
                    }
                    queryFields[fieldName] = field;
                }
            }
            else {
                // Use operationId to avoid problems differentiating operations with the
                // same path but differnet methods
                let saneFieldName = Oas3Tools.beautifyAndStore(operationId, data.saneMap);
                if (operation.inViewer) {
                    for (let securityRequirement of operation.securityRequirements) {
                        if (typeof authMutationFields[securityRequirement] !== 'object') {
                            authMutationFields[securityRequirement] = {};
                        }
                        if (saneFieldName in authMutationFields[securityRequirement]) {
                            utils_1.handleWarning({
                                typeKey: 'DUPLICATE_FIELD_NAME',
                                culprit: saneFieldName,
                                data,
                                log
                            });
                        }
                        authMutationFields[securityRequirement][saneFieldName] = field;
                    }
                }
                else {
                    if (saneFieldName in mutationFields) {
                        utils_1.handleWarning({
                            typeKey: 'DUPLICATE_FIELD_NAME',
                            culprit: saneFieldName,
                            data,
                            log
                        });
                    }
                    mutationFields[saneFieldName] = field;
                }
            }
        });
        // Sorting fields 
        queryFields = utils_1.sortObject(queryFields);
        mutationFields = utils_1.sortObject(mutationFields);
        authQueryFields = utils_1.sortObject(authQueryFields);
        Object.keys(authQueryFields).forEach((key) => {
            authQueryFields[key] = utils_1.sortObject(authQueryFields[key]);
        });
        authMutationFields = utils_1.sortObject(authMutationFields);
        Object.keys(authMutationFields).forEach((key) => {
            authMutationFields[key] = utils_1.sortObject(authMutationFields[key]);
        });
        /**
         * Count created queries / mutations
         */
        options.report.numQueriesCreated =
            Object.keys(queryFields).length +
                Object.keys(authQueryFields).reduce((sum, key) => {
                    return sum + Object.keys(authQueryFields[key]).length;
                }, 0);
        options.report.numMutationsCreated =
            Object.keys(mutationFields).length +
                Object.keys(authMutationFields).reduce((sum, key) => {
                    return sum + Object.keys(authMutationFields[key]).length;
                }, 0);
        /**
         * Organize created queries / mutations into viewer objects.
         */
        if (Object.keys(authQueryFields).length > 0) {
            Object.assign(queryFields, auth_builder_1.createAndLoadViewer(authQueryFields, data, false, oass));
        }
        if (Object.keys(authMutationFields).length > 0) {
            Object.assign(mutationFields, auth_builder_1.createAndLoadViewer(authMutationFields, data, true, oass));
        }
        /**
         * Build up the schema
         */
        const schemaConfig = {
            query: Object.keys(queryFields).length > 0
                ? new graphql_1.GraphQLObjectType({
                    name: 'Query',
                    description: 'The start of any query',
                    fields: queryFields
                })
                : GraphQLTools.getEmptyObjectType('query'),
            mutation: Object.keys(mutationFields).length > 0
                ? new graphql_1.GraphQLObjectType({
                    name: 'Mutation',
                    description: 'The start of any mutation',
                    fields: mutationFields
                })
                : null
        };
        // Fill in yet undefined Object Types to avoid GraphQLSchema from breaking.
        // The reason: once creating the schema, the 'fields' thunks will resolve
        // and if a field references an undefined Object Types, GraphQL will throw.
        Object.entries(data.operations).forEach(([opId, operation]) => {
            if (typeof operation.responseDefinition.ot === 'undefined') {
                operation.responseDefinition.ot = GraphQLTools
                    .getEmptyObjectType(operation.responseDefinition.otName);
            }
        });
        const schema = new graphql_1.GraphQLSchema(schemaConfig);
        return { schema, report: options.report };
    });
}
/**
 * Creates the field object for the given operation.
 */
function getFieldForOperation(operation, baseUrl, data, oass, requestOptions) {
    // create GraphQL Type for response:
    let type = schema_builder_1.getGraphQLType({
        def: operation.responseDefinition,
        data,
        operation,
        oass,
    });
    // create resolve function:
    let payloadSchemaName = operation.payloadDefinition
        ? operation.payloadDefinition.iotName
        : null;
    let payloadSchema = operation.payloadDefinition
        ? operation.payloadDefinition.schema
        : null;
    let resolve = resolver_builder_1.getResolver({
        operation,
        payloadName: payloadSchemaName,
        data,
        baseUrl,
        requestOptions
    });
    // create args:
    let args = schema_builder_1.getArgs({
        def: operation.payloadDefinition,
        parameters: operation.parameters,
        operation,
        data,
        oass
    });
    return {
        type,
        resolve,
        args,
        description: operation.description
    };
}
/**
 * Helper function for sorting operations based on the return type and method
 *
 * You cannot define links for operations that return arrays in the OAS
 *
 * These links are instead created by reusing the return type from other
 * operations
 *
 * Therefore, operations that return objects should be created first
 *
 * In addition, process GET operations first because their field names are based
 * on the return type (so long as there are no naming collisions).
 */
function sortOperations(op1, op2) {
    // Sort by object/array type
    if (op1.responseDefinition.schema.type === 'array' &&
        op2.responseDefinition.schema.type !== 'array') {
        return 1;
    }
    else if (op1.responseDefinition.schema.type !== 'array' &&
        op2.responseDefinition.schema.type === 'array') {
        return -1;
    }
    else {
        // Sort by GET/non-GET method
        if (op1.method === 'get' && op2.method !== 'get') {
            return -1;
        }
        else if (op1.method !== 'get' && op2.method === 'get') {
            return 1;
        }
        else {
            return 0;
        }
    }
}
//# sourceMappingURL=index.js.map