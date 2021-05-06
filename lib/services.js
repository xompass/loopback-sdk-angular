// Copyright IBM Corp. 2014,2018. All Rights Reserved.
// Node module: loopback-sdk-angular
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

const fs = require('fs');
const ejs = require('ejs');
const babel = require('@babel/core');
require('@babel/preset-env');
const extend = require('util')._extend;

// helper function to convert the given object to a quoted string
function quotedString(obj) {
  return JSON.stringify(obj, null, 2);
}

// this method is added to support both flavors of the getEndPoints method
// in strong-remoting 2.x methods `getHttpMethod()` and `getFullPath()` were used
// in strong-remoting 3.x we have deprecated those methods in favor of getEndPoints()
function getPropertyOfFirstEndpoint(remoteObj, item) {
  // strong-remoting 3.x
  if (typeof remoteObj.getEndpoints == 'function') {
    return remoteObj.getEndpoints()[0][item];
  } else { // strong-remoting 2.x
    if (item === 'verb') {
      return remoteObj.getHttpMethod();
    } else if (item === 'fullPath') {
      return remoteObj.getFullPath();
    } else {
      throw new Error('Unsupported endpoint property: %s');
    }
  }
}

/**
 * Generate Angular $resource services for the given loopback application.
 *
 * ```js
 * var generateServices = require('loopback-sdk-angular').services;
 * var app = require('./server/server');
 *
 * var client = generateServices(app, {
 *   ngModuleName: 'lbServices',
 *   apiUrl: '/api'
 * });
 * require('fs').writeFileSync('client/loopback.js', client, 'utf-8');
 * ```
 *
 * To preserve backwards compatibility, the three-arg variant is still
 * supported:
 *
 * ```js
 * var client = generateServices(app, 'lbServices', '/api');
 * ```
 *
 * @param {Object} app The loopback application created via `app = loopback()`.
 * @param {Object} options
 * @param {string=} options.ngModuleName A name for the generated Angular module.
 *   Default: `lbServices`.
 * @param {string=} options.apiUrl The URL where the client can access the LoopBack
 *   server app. Default: `/`.
 * @param {Boolean} options.includeSchema Include model definition.
 * @returns {string} The generated javascript code.
 * @header generateServices
 */
module.exports = function generateServices(app, options) {
  if (typeof options === 'string') {
    // legacy API: generateServices(app, ngModuleName, apiUrl)
    options = {
      ngModuleName: arguments[1],
      apiUrl: arguments[2],
    };
  }

  options = extend({
    ngModuleName: 'lbServices',
    apiUrl: '/',
    includeCommonModules: true,
    namespaceModels: false,
    namespaceCommonModels: false,
    namespaceDelimiter: '.',
    modelsToIgnore: [],
    comments: false,
  }, options);

  const models = describeModels(app, options);

  const servicesTemplate = fs.readFileSync(require.resolve('./services.template.ejs'), {encoding: 'utf-8'});

  let commonModelPrefix = 'LoopBack';
  if (options.namespaceCommonModels) {
    commonModelPrefix = options.ngModuleName + options.namespaceDelimiter;
    if (options.namespaceDelimiter === '.') {
      throw new Error('Unsupported delimiter \'.\' for ' +
        'namespacing common models.');
    }
    commonModelPrefix = commonModelPrefix.replace(/\./g,
      options.namespaceDelimiter);
  }

  const sdk = ejs.render(servicesTemplate, {
    moduleName: options.ngModuleName,
    models: models,
    commonAuth: commonModelPrefix + 'Auth',
    commonAuthRequestInterceptor: commonModelPrefix + 'AuthRequestInterceptor',
    commonResource: commonModelPrefix + 'Resource',
    commonResourceProvider: commonModelPrefix + 'ResourceProvider',
    urlBase: options.apiUrl.replace(/\/+$/, ''),
    includeCommonModules: options.includeCommonModules,

    helpers: {
      getPropertyOfFirstEndpoint: getPropertyOfFirstEndpoint,
      quotedString: quotedString,
    },
    comments: options.comments,
  });

  try {
    return babel.transformSync(sdk).code;
  } catch (e) {
    console.log(e);
    throw new Error(e.message);
  }


  /*const result = uglify.minify(sdk);

  if (result.error) {
    throw new Error(result.error);
  }

  return result.code;*/
};

function normalizeDescription(desc) {
  return Array.isArray(desc) ? desc.join('\n') : desc;
}


function getFormattedModelName(modelName, options) {
  // Always capitalize first letter of model name
  var resourceModelName = modelName[0].toUpperCase() + modelName.slice(1);

  // Prefix with the module name and delimiter if namespacing is on
  if (options.namespaceModels) {
    resourceModelName = options.ngModuleName +
      options.namespaceDelimiter + resourceModelName;
  }
  return resourceModelName;
}

function describeModels(app, options) {
  var result = {};
  var modelsToIgnore = options.modelsToIgnore;

  app.handler('rest').adapter.getClasses().forEach(function (c) {
    var name = getFormattedModelName(c.name, options);
    c.description = normalizeDescription(
      c.sharedClass.ctor.settings.description,
    );

    if (modelsToIgnore.indexOf(name) >= 0) {
      // Skip classes that are provided in options.modelsToIgnore array
      // We don't want to publish these models in angular app
      console.warn(`Skipping ${name} model as it is not to be published`);
      return;
    }

    if (!c.ctor) {
      // Skip classes that don't have a shared ctor
      // as they are not LoopBack models
      console.error(`Skipping ${name} as it is not a {{LoopBack}} model`);
      return;
    }

    const createMethod = c.methods.filter(function (method) {
      return method.name === 'create';
    });

    if (createMethod && createMethod.length === 1) {
      const createMany = Object.create(createMethod[0]);
      createMany.name = 'createMany';
      createMany.isReturningArray = function () {
        return true;
      };
      c.methods.push(createMany);
    }

    // The URL of prototype methods include sharedCtor parameters like ":id"
    // Because all $resource methods are static (non-prototype) in ngResource,
    // the sharedCtor parameters should be added to the parameters
    // of prototype methods.
    c.methods.forEach(function fixArgsOfPrototypeMethods(method, key) {
      const ctor = method.restClass.ctor;
      if (!ctor || method.sharedMethod.isStatic) return;
      method.accepts = ctor.accepts.concat(method.accepts);

      if (!method.accepts) return;

      // Any extra http action arguments in the path need to be added to the
      // angular resource actions as params
      method.accepts.forEach(function findResourceParams(arg) {
        if (!arg.http) return;

        if (arg.http.source === 'path' && arg.arg !== 'id') {
          if (!method.resourceParams) {
            method.resourceParams = [];
            method.hasResourceParams = true;
          }
          method.resourceParams.push(arg);
        }
      });
    });

    c.methods.forEach(function fixDescription(method) {
      method.description = normalizeDescription(method.description);
    });

    c.isUser = c.sharedClass.ctor.prototype instanceof app.loopback.User ||
      c.sharedClass.ctor.prototype === app.loopback.User.prototype;
    result[name] = c;
  });

  buildScopes(result, options, app);

  if (options.includeSchema) {
    buildSchemas(result, app);
  }

  return result;
}

var SCOPE_METHOD_REGEX = /^prototype.__([^_]+)__(.+)$/;

function buildScopes(models, options, app) {
  for (let modelName in models) {
    buildScopesOfModel(models, modelName, options, app);
  }
}

function buildScopesOfModel(models, modelName, options, app) {
  const modelClass = models[modelName];

  modelClass.scopes = {};
  modelClass.methods.forEach(function (method) {
    buildScopeMethod(models, modelName, method, options, app);
  });

  return modelClass;
}

// reverse-engineer scope method
// defined by loopback-datasource-juggler/lib/scope.js
function buildScopeMethod(models, modelName, method, options, app) {
  const modelClass = models[modelName];
  const match = method.name.match(SCOPE_METHOD_REGEX);
  if (!match) return;

  const op = match[1];
  const scopeName = match[2];
  const modelPrototype = modelClass.sharedClass.ctor.prototype;
  const targetClass = modelPrototype[scopeName] &&
    modelPrototype[scopeName]._targetClass;
  const targetModelName = targetClass ?
    getFormattedModelName(targetClass, options) :
    targetClass;

  if (modelClass.scopes[scopeName] === undefined) {
    if (!targetClass) {
      return;
    }

    if (!findModelByName(models, targetModelName)) {
      modelClass.scopes[scopeName] = null;
      return;
    }

    const methodName = method.name.replace('prototype.', '');
    const _swaggerMethods = app.models[modelName].sharedClass._swaggerMethods;
    if (_swaggerMethods && !_swaggerMethods[methodName]) {
      return;
    }

    modelClass.scopes[scopeName] = {
      methods: {},
      targetClass: targetModelName,
    };
  } else if (modelClass.scopes[scopeName] === null) {
    // Skip the scope, the warning was already reported
    return;
  }

  var apiName = scopeName;
  if (op === 'get') {
    // no-op, create the scope accessor
  } else if (op === 'delete') {
    apiName += '.destroyAll';
  } else {
    apiName += '.' + op;
  }

  // Names of resources/models in Angular start with a capital letter
  const ngModelName = modelName[0].toUpperCase() + modelName.slice(1);
  method.internal = 'Use ' + ngModelName + '.' + apiName + '() instead.';

  // build a reverse record to be used in ngResource
  // Product.__find__categories -> Category.::find::product::categories
  const reverseName = '::' + op + '::' + modelName + '::' + scopeName;

  const reverseMethod = Object.create(method);
  reverseMethod.name = reverseName;
  reverseMethod.internal = 'Use ' + ngModelName + '.' + apiName + '() instead.';
  // override possibly inherited values
  reverseMethod.deprecated = false;

  const reverseModel = findModelByName(models, targetModelName);
  reverseModel.methods.push(reverseMethod);
  if (reverseMethod.name.match(/create/)) {
    const createMany = Object.create(reverseMethod);
    createMany.name = createMany.name.replace(
      /create/,
      'createMany',
    );
    createMany.internal = createMany.internal.replace(
      /create/,
      'createMany',
    );
    createMany.isReturningArray = function () {
      return true;
    };
    reverseModel.methods.push(createMany);
  }

  const scopeMethod = Object.create(method);
  scopeMethod.name = reverseName;
  // override possibly inherited values
  scopeMethod.deprecated = false;
  scopeMethod.internal = false;
  modelClass.scopes[scopeName].methods[apiName] = scopeMethod;
  if (scopeMethod.name.match(/create/)) {
    const scopeCreateMany = Object.create(scopeMethod);
    scopeCreateMany.name = scopeCreateMany.name.replace(
      /create/,
      'createMany',
    );
    scopeCreateMany.isReturningArray = function () {
      return true;
    };
    apiName = apiName.replace(/create/, 'createMany');
    modelClass.scopes[scopeName].methods[apiName] = scopeCreateMany;
  }
}

function findModelByName(models, name) {
  for (let n in models) {
    if (n.toLowerCase() === name.toLowerCase())
      return models[n];
  }
}

function buildSchemas(models, app) {
  for (const modelName in models) {
    const modelProperties = app.models[modelName].definition.properties;
    const schema = {};
    for (let prop in modelProperties) {
      schema[prop] = extend({}, modelProperties[prop]);
      // normalize types - convert from ctor (function) to name (string)
      let type = schema[prop].type;
      if (typeof type === 'function') {
        type = type.modelName || type.name;
      }
      // TODO - handle array types
      schema[prop].type = type;
    }

    models[modelName].modelSchema = {
      name: modelName,
      properties: schema,
    };
  }
}
