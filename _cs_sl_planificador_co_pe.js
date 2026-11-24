/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/ui/serverWidget',
    'N/xml',
    'N/search',
    'N/file',
    'N/runtime',
    'N/record',
    'N/log',
    'N/format',
    'N/url'
], (
    serverWidget,
    xml,
    search,
    file,
    runtime,
    record,
    log,
    format,
    url
) => {

    /**
     * Registra en el log de ejecución el error capturado por una función.
     * Cada objeto de error se registra una sola vez aunque se relance
     * por varias funciones anidadas. Nunca lanza excepciones propias.
     */
    const LOGGED_ERRORS = typeof WeakSet === 'function' ? new WeakSet() : null;

    const logFunctionError = (functionName, functionError) => {
        try {
            if (functionError !== null && typeof functionError === 'object' && LOGGED_ERRORS) {
                if (LOGGED_ERRORS.has(functionError)) return;
                LOGGED_ERRORS.add(functionError);
            }

            let serialized;
            try {
                serialized = JSON.stringify(functionError);
            } catch (serializeError) {
                serialized = String(functionError);
            }

            log.error({
                title: `Error en ${functionName}`,
                details: {
                    name: functionError && functionError.name,
                    message: functionError && functionError.message,
                    stack: functionError && functionError.stack,
                    error: serialized
                }
            });
        } catch (logError) {
            try {
                log.error({ title: `Error en ${functionName}`, details: String(functionError) });
            } catch (ignore) {
                // El registro de errores nunca debe interrumpir la ejecución.
            }
        }
    };


    const CONFIG = {
        FILE_FOLDER_ID: 1836,

        /*
         * Cuenta de CxP solicitada para las facturas creadas
         * desde este planificador.
         *
         * Se resuelve por número de cuenta para no depender
         * de un Internal ID diferente entre ambientes.
         */
        AP_ACCOUNT_NUMBER: '20606010101',

        COUNTRY: {
            MX: {
                name: 'México',
                subsidiaryCountry: 'MX',
                bankCountryId: 157,
                vendorTaxIdField: 'custentity_mx_rfc',
                transactionTaxIdField: 'custbody_cfdi_uuid',
                plateRecord: 'customrecord_fvr_mx_placas',
                bankAccountLabel: 'CLABE'
            },
            PE: {
                name: 'Perú',
                subsidiaryCountry: 'PE',
                bankCountryId: 174,
                vendorTaxIdField: null,
                transactionTaxIdField: 'custbody_cfdi_uuid',
                plateRecord: null,
                bankAccountLabel: 'Cuenta bancaria / CCI'
            },
            CO: {
                name: 'Colombia',
                subsidiaryCountry: 'CO',
                bankCountryId: 48,
                vendorTaxIdField: null,
                transactionTaxIdField: 'custbody_cfdi_uuid',
                plateRecord: null,
                bankAccountLabel: 'Cuenta bancaria'
            }
        },

        TAX_MAPPING: {
            RECORD: 'customrecord_cs_einvoice_tax_mapping',
            COUNTRY: 'custrecord_cs_tax_country',
            XML_CODE: 'custrecord_cs_tax_xml_code',
            BEHAVIOR: 'custrecord_cs_tax_behavior',
            TAX_NAME: 'custrecord_cs_tax_name',
            NETSUITE_TAX_CODE: 'custrecord_cs_tax_netsuite',
            RATE: 'custrecord_cs_tax_rate'
        },

        ITEM_PARAMETERS: {
            RECORD: 'customrecord_fvr_parametrizacion_articul',
            PARENT_ITEM: 'custrecord_fvr_art_padre',
            CHILD_ITEM: 'custrecord_fvr_art_hijo',
            CURRENCY: 'custrecord_fvr_moneda',
            MIN_AMOUNT: 'custrecord_fvr_monto_minimo',
            MAX_AMOUNT: 'custrecord_fvr_monto_maximo'
        },

        FIELDS: {
            TAX_RATE: 'custrecord_fi_tasa_o_cuota',
            TAX_PERCENT: 'custrecord_cs_porcentaje_impuesto',
            CREATED_BY_PLANNER: 'custbody_cs_creado_planificador_co_pe',
            XML_FILE: 'custbody_cs_xml_document',
            PDF_FILE: 'custbody_cs_pdf_document_',
            REGIONAL_HEADER: 'custbody_cs_regional_planificador',
            BRAND_HEADER: 'custbody_marca',
            BRAND_SEGMENT_HEADER: 'cseg_marca',
            JUSTIFICATION_HEADER: 'custbody_compras_justifica',
            DESCRIPTION_HEADER: 'custbody_descripcion_vb',
            PLATE_HEADER: 'custbody_fin_placa',

            REGIONAL_LINE: 'custcol_cs_regional_linea',
            BRAND_LINE: 'custcol_marca',
            BRAND_SEGMENT_LINE: 'cseg_marca',
            TAX_LINE: 'custcol_cs_codigo_impuesto',
            RETENTIONS_LINE: 'custcol_cs_retenciones_planificador',
            VENDOR_LINE: 'custcol_mx_vendor',
            GD_NAME_LINE: 'custcol_gd_name',
            EXPECTED_TOTAL_LINE: 'custcol_cs_total_planificador',
            DUE_DATE_LINE: 'custcol_fecha_vencimiento',

            EXPENSE_CATEGORY_ACCOUNT: 'custrecord_cs_cuenta_pasivo_plani',
            EXPENSE_CATEGORY_AVAILABLE: 'custrecord_fact_planificador',
            ITEM_SHOW_IN_PLANNER: 'custitem_fi_uni_mostrar_planificador',
            BRAND_SEGMENT_SOURCE: 'cseg_marca'
        }
    };

    // -------------------------------------------------------------------------
    // Utilidades generales
    // -------------------------------------------------------------------------

    const toNumber = value => {
        try {
            const number = Number(String(value || '0').replace(/,/g, ''));
            return Number.isFinite(number) ? number : 0;
        } catch (functionError) {
            logFunctionError('toNumber', functionError);
            throw functionError;
        }
    };

    const cleanText = value => {
        try {
            return String(value || '').trim();
        } catch (functionError) {
            logFunctionError('cleanText', functionError);
            throw functionError;
        }
    };

    const normalizeIssueDate = value => {
        try {

            const text =
                cleanText(value);

            if (!text) {
                return '';
            }

            /*
             * Admite:
             *
             * 2026-08-03
             * 2026-08-03T11:38:00
             * 2026-08-03T11:38:00-06:00
             */
            const isoMatch =
                text.match(
                    /^(\d{4})-(\d{2})-(\d{2})/
                );

            if (isoMatch) {
                return (
                    `${isoMatch[1]}-` +
                    `${isoMatch[2]}-` +
                    `${isoMatch[3]}`
                );
            }

            return '';
        } catch (functionError) {
            logFunctionError('normalizeIssueDate', functionError);
            throw functionError;
        }
    };

    const normalizeTaxId = value => {
        try {
            return cleanText(value)
                .toUpperCase()
                .replace(/[\s.\-]/g, '');
        } catch (functionError) {
            logFunctionError('normalizeTaxId', functionError);
            throw functionError;
        }
    };

    const escapeHtml = value => {
        try {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        } catch (functionError) {
            logFunctionError('escapeHtml', functionError);
            throw functionError;
        }
    };

    const getAttributeAny = (node, names) => {
        try {
            if (!node) return '';
            for (const name of names) {
                const value = node.getAttribute({ name }) || node.getAttribute(name);
                if (value !== null && value !== undefined && value !== '') return value;
            }
            return '';
        } catch (functionError) {
            logFunctionError('getAttributeAny', functionError);
            throw functionError;
        }
    };

    const selectNodes = (document, xpath, namespaces = {}) => {
        try {
            return xml.XPath.select({ node: document, xpath, namespaces }) || [];
        } catch (error) {
            log.debug('XPath sin resultados', { xpath, message: error.message });
            return [];
        }
    };

    const selectFirst = (document, xpath, namespaces = {}) => {
        try {
            return selectNodes(document, xpath, namespaces)[0] || null;
        } catch (functionError) {
            logFunctionError('selectFirst', functionError);
            throw functionError;
        }
    };

    const nodeText = node => {
        try {
            return cleanText(node?.textContent || node?.text || '');
        } catch (functionError) {
            logFunctionError('nodeText', functionError);
            throw functionError;
        }
    };

    const firstText = (document, xpaths, namespaces = {}) => {
        try {
            for (const xpath of xpaths) {
                const value = nodeText(selectFirst(document, xpath, namespaces));
                if (value) return value;
            }
            return '';
        } catch (functionError) {
            logFunctionError('firstText', functionError);
            throw functionError;
        }
    };

    const addHiddenField = (form, id, value, type = serverWidget.FieldType.TEXT) => {
        try {
            const field = form.addField({ id, type, label: id });
            field.defaultValue = value === null || value === undefined ? '' : String(value);
            field.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            return field;
        } catch (functionError) {
            logFunctionError('addHiddenField', functionError);
            throw functionError;
        }
    };

    const getNextWednesday = () => {
        try {
            const today = new Date();
            let days = (3 - today.getDay() + 7) % 7;

            // Si hoy es miércoles, toma el miércoles de la siguiente semana
            if (days === 0) days = 7;

            const result = new Date(today);
            result.setDate(today.getDate() + days);

            return result;
        } catch (functionError) {
            logFunctionError('getNextWednesday', functionError);
            throw functionError;
        }
    };

    const getNextThursday = () => {
        try {
            const today = new Date();
            let days = (4 - today.getDay() + 7) % 7;
            if (days === 0) days = 7;
            const result = new Date(today);
            result.setDate(today.getDate() + days);
            return result;
        } catch (functionError) {
            logFunctionError('getNextThursday', functionError);
            throw functionError;
        }
    };

    const parseNetSuiteDate = value => {

        const text =
            cleanText(value);

        if (!text) {
            return null;
        }


        // ============================================================
        // FORMATO ISO / HTML
        // 2026-08-03
        // 2026-08-03T11:38:00
        // ============================================================

        const isoMatch =
            text.match(
                /^(\d{4})-(\d{2})-(\d{2})/
            );

        if (isoMatch) {

            return new Date(
                Number(isoMatch[1]),
                Number(isoMatch[2]) - 1,
                Number(isoMatch[3]),
                12,
                0,
                0
            );
        }


        // ============================================================
        // FORMATO SEGÚN PREFERENCIAS DE NETSUITE
        // ============================================================

        try {

            return format.parse({
                value: text,
                type: format.Type.DATE
            });

        } catch (error) {

            // Respaldo DD/MM/YYYY
            const parts =
                text.split('/');

            if (parts.length === 3) {

                return new Date(
                    Number(parts[2]),
                    Number(parts[1]) - 1,
                    Number(parts[0]),
                    12,
                    0,
                    0
                );
            }

            return null;
        }
    };

    const safeSetValue = (rec, fieldId, value) => {
        if (!fieldId || value === '' || value === null || value === undefined) return;
        try {
            rec.setValue({ fieldId, value });
        } catch (error) {
            log.error('No fue posible asignar campo', { fieldId, value, message: error.message });
        }
    };

    const safeSetCurrentValue = (rec, sublistId, fieldId, value) => {
        if (!fieldId || value === '' || value === null || value === undefined) return;
        try {
            rec.setCurrentSublistValue({ sublistId, fieldId, value, forceSyncSourcing: true });
        } catch (error) {
            log.error('No fue posible asignar campo de línea', {
                sublistId,
                fieldId,
                value,
                message: error.message
            });
        }
    };


    /**
     * Localiza la cuenta contable por número.
     * Se usa para asignar la cuenta CxP del encabezado de la Vendor Bill.
     */
    const findAccountByNumber = accountNumber => {
        try {

            const normalized =
                cleanText(accountNumber);

            if (!normalized) {
                return '';
            }

            const results =
                search.create({
                    type: 'account',
                    filters: [
                        ['number', 'is', normalized],
                        'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: [
                        search.createColumn({
                            name: 'internalid'
                        }),
                        search.createColumn({
                            name: 'number'
                        }),
                        search.createColumn({
                            name: 'name'
                        })
                    ]
                })
                    .run()
                    .getRange({
                        start: 0,
                        end: 2
                    });


            if (!results.length) {

                throw new Error(
                    `No se encontró la cuenta ${normalized} en NetSuite.`
                );
            }


            if (results.length > 1) {

                log.error({
                    title:
                        'Cuenta contable duplicada por número',

                    details: {
                        accountNumber:
                            normalized,

                        ids:
                            results.map(
                                result =>
                                    result.getValue({
                                        name:
                                            'internalid'
                                    })
                            )
                    }
                });
            }


            const accountId =
                results[0].getValue({
                    name:
                        'internalid'
                });


            log.audit({
                title:
                    'Cuenta CxP localizada',

                details: {
                    accountNumber:
                        normalized,

                    accountId,

                    accountName:
                        results[0].getValue({
                            name:
                                'name'
                        })
                }
            });


            return String(
                accountId || ''
            );
        } catch (functionError) {
            logFunctionError('findAccountByNumber', functionError);
            throw functionError;
        }
    };


    /**
     * Obtiene la Regional/Location asignada al usuario actual.
     *
     * 1. Intenta runtime.getCurrentUser().location.
     * 2. Como respaldo consulta el Employee del usuario.
     * 3. Sólo devuelve el valor si pertenece a las opciones permitidas
     *    para la subsidiaria/país de la factura.
     */
    const getCurrentUserRegionalDefault = locationOptions => {

        try {

            const currentUser =
                runtime.getCurrentUser();


            let locationId =
                cleanText(
                    currentUser.location
                );


            if (
                !locationId &&
                currentUser.id
            ) {

                try {

                    const employeeData =
                        search.lookupFields({
                            type:
                                search.Type.EMPLOYEE,

                            id:
                                currentUser.id,

                            columns: [
                                'location'
                            ]
                        });


                    locationId =
                        cleanText(
                            employeeData.location &&
                                employeeData.location.length
                                ? employeeData.location[0].value
                                : ''
                        );

                } catch (employeeError) {

                    log.debug({
                        title:
                            'No fue posible obtener Regional desde Employee',

                        details: {
                            userId:
                                currentUser.id,

                            message:
                                employeeError.message
                        }
                    });
                }
            }


            if (!locationId) {

                log.audit({
                    title:
                        'Usuario sin Regional por defecto',

                    details: {
                        userId:
                            currentUser.id
                    }
                });

                return '';
            }


            const exists =
                (locationOptions || []).some(
                    option =>
                        String(
                            option.value
                        ) ===
                        String(
                            locationId
                        )
                );


            if (!exists) {

                log.audit({
                    title:
                        'Regional del usuario fuera de opciones del país',

                    details: {
                        userId:
                            currentUser.id,

                        locationId
                    }
                });

                return '';
            }


            log.audit({
                title:
                    'Regional cargada por defecto desde usuario',

                details: {
                    userId:
                        currentUser.id,

                    locationId
                }
            });


            return String(
                locationId
            );


        } catch (error) {

            log.error({
                title:
                    'Error obteniendo Regional del usuario',

                details:
                    error
            });

            return '';
        }
    };


    /**
     * Para proveedor existente, algunos registros heredados provocan
     * DUP_VENDOR_NAME simplemente al hacer vendor.save(), aun cuando
     * no se esté cambiando companyname/entityid.
     *
     * La factura no debe bloquearse por ese problema de mantenimiento
     * del maestro. Sólo se ignora específicamente DUP_VENDOR_NAME.
     */
    const executeExistingVendorUpdate = (
        label,
        callback,
        vendorId
    ) => {

        try {

            const result =
                callback();

            return (
                result ||
                vendorId
            );


        } catch (error) {

            const errorName =
                cleanText(
                    error.name ||
                    error.code
                ).toUpperCase();


            const errorMessage =
                cleanText(
                    error.message
                ).toUpperCase();


            const isDuplicateName =
                errorName ===
                'DUP_VENDOR_NAME' ||
                errorMessage.includes(
                    'NOMBRE DE ENTIDAD ÚNICO'
                ) ||
                errorMessage.includes(
                    'ENTITY NAME'
                );


            if (!isDuplicateName) {
                throw error;
            }


            log.error({
                title:
                    `${label} omitida por DUP_VENDOR_NAME`,

                details: {
                    vendorId,

                    errorName,

                    message:
                        error.message
                }
            });


            /*
             * El proveedor ya fue encontrado correctamente por NIT/RUC/RFC.
             * Continuamos creando la factura sin intentar crear otro proveedor.
             */
            return vendorId;
        }
    };


    /**
     * Asigna un campo Select/List sin conocer el custom list de origen.
     * Intenta resolver por texto/valor usando las opciones disponibles del campo.
     * Si no puede resolverlo, registra diagnóstico y continúa.
     */
    const setSelectByCandidates = (rec, fieldId, candidates = []) => {

        const values = (candidates || [])
            .map(value => cleanText(value))
            .filter(Boolean);

        if (!fieldId || !values.length) {
            return false;
        }

        const normalizeOption = value => {
            try {
                return cleanText(value)
                    .toUpperCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/[.,]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            } catch (functionError) {
                logFunctionError('setSelectByCandidates.normalizeOption', functionError);
                throw functionError;
            }
        };

        try {
            const field = rec.getField({ fieldId });

            if (field && typeof field.getSelectOptions === 'function') {

                for (const candidate of values) {

                    let options = [];

                    try {
                        options = field.getSelectOptions({
                            filter: candidate,
                            operator: 'is'
                        }) || [];
                    } catch (e) {
                        options = [];
                    }

                    if (!options.length) {
                        try {
                            options = field.getSelectOptions({
                                filter: candidate
                            }) || [];
                        } catch (e) {
                            options = [];
                        }
                    }

                    const expected = normalizeOption(candidate);

                    const exact = options.find(option =>
                        normalizeOption(option.text) === expected ||
                        normalizeOption(option.value) === expected
                    );

                    const selected = exact || (options.length === 1 ? options[0] : null);

                    if (selected && selected.value !== '' && selected.value !== null && selected.value !== undefined) {
                        rec.setValue({
                            fieldId,
                            value: selected.value
                        });

                        log.audit({
                            title: 'Campo catálogo Colombia asignado',
                            details: {
                                fieldId,
                                candidate,
                                selectedValue: selected.value,
                                selectedText: selected.text
                            }
                        });

                        return true;
                    }
                }
            }

            /*
             * NO usamos setText() como fallback.
             *
             * NetSuite puede aceptar temporalmente un texto que no corresponde
             * a una referencia válida y fallar después en record.save() con
             * INVALID_KEY_OR_REF o incluso UNEXPECTED_ERROR.
             *
             * Sólo asignamos valores Select cuando getSelectOptions() devuelve
             * una referencia real del catálogo.
             */

        } catch (error) {
            log.error({
                title: 'No fue posible resolver catálogo Colombia',
                details: {
                    fieldId,
                    candidates: values,
                    message: error.message
                }
            });
        }

        log.error({
            title: 'Valor Colombia sin correspondencia en catálogo',
            details: {
                fieldId,
                candidates: values
            }
        });

        return false;
    };

    // -------------------------------------------------------------------------
    // Impuestos
    // -------------------------------------------------------------------------

    const normalizeTaxType = value => {
        try {
            const normalized = cleanText(value)
                .toUpperCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '');

            if (['TRANSFER', 'TRASLADO', 'IMPUESTO', 'TAX'].includes(normalized)) {
                return 'TRANSFER';
            }

            if ([
                'WITHHOLDING',
                'RETENCION',
                'RETENTION',
                'RETEFUENTE',
                'RETEIVA',
                'RETEICA'
            ].includes(normalized)) {
                return 'WITHHOLDING';
            }

            if (['DETRACTION', 'DETRACCION', 'DETRACCIONES'].includes(normalized)) {
                return 'DETRACTION';
            }

            if (['EXEMPT', 'EXONERADO', 'EXONERADA'].includes(normalized)) {
                return 'EXEMPT';
            }

            if (['UNAFFECTED', 'INAFECTO', 'INAFECTA', 'NO GRAVADO'].includes(normalized)) {
                return 'UNAFFECTED';
            }

            return normalized;
        } catch (functionError) {
            logFunctionError('normalizeTaxType', functionError);
            throw functionError;
        }
    };

    /**
     * Convierte las tasas a porcentaje.
     * México entrega 0.160000 y UBL normalmente entrega 16.
     * Ambos valores se normalizan a 16.
     */
    const normalizeTaxRate = (value, countryCode = '') => {
        try {

            let text = cleanText(value);

            if (!text) {
                return 0;
            }

            text = text
                .replace(/\s/g, '')
                .replace('%', '')
                .replace(',', '.');

            let rate = Number(text);

            if (!Number.isFinite(rate)) {
                return 0;
            }

            const country =
                cleanText(countryCode).toUpperCase();

            /*
             * México CFDI expresa TasaOCuota como fracción:
             * 0.160000 = 16%
             * 0.080000 = 8%
             *
             * UBL (Colombia / Perú) ya expresa Percent como porcentaje:
             * 19.00 = 19%
             * 11.00 = 11%
             * 0.80  = 0.80%
             * 1.10  = 1.10%
             */
            if (
                country === 'MX' &&
                rate > 0 &&
                rate <= 1
            ) {
                rate *= 100;
            }

            return Number(
                rate.toFixed(6)
            );
        } catch (functionError) {
            logFunctionError('normalizeTaxRate', functionError);
            throw functionError;
        }
    };

    const emptyTaxConfiguration = () => {
        try {
            return ({
                taxId: '',
                taxName: '',
                mappingId: '',
                configuredName: '',
                configuredRate: '',
                configuredBehavior: '',
                options: [],
                requiresSelection: false
            });
        } catch (functionError) {
            logFunctionError('emptyTaxConfiguration', functionError);
            throw functionError;
        }
    };

    /**
     * Obtiene el Tax Code de NetSuite desde el registro personalizado:
     * País + Código fiscal del XML + Comportamiento + Tasa.
     */
    const findConfiguredTaxCode = (
        countryCode,
        authorityCode,
        taxType,
        taxRate
    ) => {
        try {

            const normalizedCountry =
                cleanText(
                    countryCode
                ).toUpperCase();


            const normalizedCode =
                cleanText(
                    authorityCode
                ).toUpperCase();


            const normalizedType =
                normalizeTaxType(
                    taxType
                );


            const normalizedRate =
                normalizeTaxRate(
                    taxRate,
                    normalizedCountry
                );


            if (
                !normalizedCountry ||
                !normalizedCode ||
                !normalizedType
            ) {

                return emptyTaxConfiguration();
            }


            const expectedCountryName =
                CONFIG.COUNTRY[
                    normalizedCountry
                ]
                    ? CONFIG.COUNTRY[
                        normalizedCountry
                    ].name
                    : normalizedCountry;


            const normalizeText = value => {
                try {
                    return cleanText(value)
                        .toUpperCase()
                        .normalize('NFD')
                        .replace(
                            /[\u0300-\u036f]/g,
                            ''
                        );
                } catch (functionError) {
                    logFunctionError('findConfiguredTaxCode.normalizeText', functionError);
                    throw functionError;
                }
            };


            log.audit({
                title:
                    'Buscando configuración impuesto',

                details: {
                    country:
                        normalizedCountry,

                    countryName:
                        expectedCountryName,

                    xmlCode:
                        normalizedCode,

                    behavior:
                        normalizedType,

                    rate:
                        normalizedRate
                }
            });


            // ============================================================
            // BUSCAR POR CÓDIGO XML
            //
            // El país se filtrará posteriormente por texto porque
            // custrecord_cs_tax_country es List/Record.
            // ============================================================

            const results =
                search.create({

                    type:
                        CONFIG.TAX_MAPPING.RECORD,

                    filters: [

                        [
                            CONFIG.TAX_MAPPING.XML_CODE,
                            'is',
                            normalizedCode
                        ],

                        'AND',

                        [
                            'isinactive',
                            'is',
                            'F'
                        ]
                    ],

                    columns: [

                        'internalid',

                        CONFIG.TAX_MAPPING.COUNTRY,

                        CONFIG.TAX_MAPPING.BEHAVIOR,

                        CONFIG.TAX_MAPPING.TAX_NAME,

                        CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE,

                        CONFIG.TAX_MAPPING.RATE
                    ]

                })
                    .run()
                    .getRange({
                        start: 0,
                        end: 100
                    });


            // ============================================================
            // PREPARAR CANDIDATOS
            // ============================================================

            const candidates =
                results.map(
                    result => {


                        const countryText =
                            result.getText({
                                name:
                                    CONFIG.TAX_MAPPING.COUNTRY
                            }) || '';


                        const countryValue =
                            result.getValue({
                                name:
                                    CONFIG.TAX_MAPPING.COUNTRY
                            }) || '';


                        const behaviorText =
                            result.getText({
                                name:
                                    CONFIG.TAX_MAPPING.BEHAVIOR
                            }) || '';


                        const behaviorValue =
                            result.getValue({
                                name:
                                    CONFIG.TAX_MAPPING.BEHAVIOR
                            }) || '';


                        const rateRaw =
                            result.getValue({
                                name:
                                    CONFIG.TAX_MAPPING.RATE
                            });


                        const taxId =
                            result.getValue({
                                name:
                                    CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE
                            }) || '';


                        const taxText =
                            result.getText({
                                name:
                                    CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE
                            }) || '';


                        const configuredName =
                            result.getText({
                                name:
                                    CONFIG.TAX_MAPPING.TAX_NAME
                            }) ||
                            result.getValue({
                                name:
                                    CONFIG.TAX_MAPPING.TAX_NAME
                            }) ||
                            '';


                        const candidate = {

                            mappingId:
                                result.getValue({
                                    name:
                                        'internalid'
                                }) || '',


                            countryText,

                            countryValue,


                            behaviorText,

                            behaviorValue,


                            behavior:
                                normalizeTaxType(
                                    behaviorText ||
                                    behaviorValue
                                ),


                            rateRaw,

                            rate:
                                normalizeTaxRate(
                                    rateRaw,
                                    normalizedCountry
                                ),


                            configuredName,

                            taxId,

                            taxText
                        };


                        log.audit({
                            title:
                                'Candidato configuración fiscal',

                            details: {

                                mappingId:
                                    candidate.mappingId,

                                countryText:
                                    candidate.countryText,

                                countryValue:
                                    candidate.countryValue,

                                behaviorText:
                                    candidate.behaviorText,

                                behaviorValue:
                                    candidate.behaviorValue,

                                behaviorNormalized:
                                    candidate.behavior,

                                rateRaw:
                                    candidate.rateRaw,

                                rateNormalized:
                                    candidate.rate,

                                requestedCountry:
                                    normalizedCountry,

                                requestedBehavior:
                                    normalizedType,

                                requestedRate:
                                    normalizedRate,

                                taxId:
                                    candidate.taxId,

                                taxText:
                                    candidate.taxText
                            }
                        });


                        return candidate;
                    }
                );


            // ============================================================
            // FILTRAR POR PAÍS
            // ============================================================

            const expectedCountry =
                normalizeText(
                    expectedCountryName
                );


            const countryCandidates =
                candidates.filter(
                    candidate => {

                        const configuredCountry =
                            normalizeText(
                                candidate.countryText
                            );


                        return (
                            configuredCountry ===
                            expectedCountry
                        );
                    }
                );


            log.audit({
                title:
                    'Configuraciones después de filtrar país',

                details: {
                    requestedCountry:
                        normalizedCountry,

                    expectedCountryName:
                        expectedCountryName,

                    totalCandidates:
                        candidates.length,

                    countryCandidates:
                        countryCandidates.length
                }
            });


            if (!countryCandidates.length) {

                return emptyTaxConfiguration();
            }



            // ============================================================
            // CASO ESPECIAL COLOMBIA - CÓDIGO ZZ
            //
            // Para ZZ tomamos directamente el Tax Code configurado en
            // custrecord_cs_tax_netsuite, sin validar comportamiento/tasa.
            // ============================================================

            if (
                normalizedCountry === 'CO' &&
                normalizedCode === 'ZZ'
            ) {

                const zzCandidates =
                    countryCandidates.filter(
                        candidate => candidate.taxId
                    );

                if (zzCandidates.length === 1) {

                    const zz =
                        zzCandidates[0];

                    log.audit({
                        title:
                            'Configuración ZZ encontrada',

                        details: {
                            country:
                                normalizedCountry,

                            xmlCode:
                                normalizedCode,

                            mappingId:
                                zz.mappingId,

                            taxId:
                                zz.taxId,

                            taxName:
                                zz.taxText,

                            configuredRate:
                                zz.rate,

                            configuredBehavior:
                                zz.behavior
                        }
                    });


                    return {

                        mappingId:
                            zz.mappingId,

                        configuredName:
                            zz.configuredName,

                        configuredRate:
                            zz.rate,

                        configuredBehavior:
                            zz.behaviorText ||
                            zz.behaviorValue,

                        taxId:
                            zz.taxId,

                        taxName:
                            zz.taxText,

                        options: [
                            {
                                mappingId:
                                    zz.mappingId,

                                configuredName:
                                    zz.configuredName,

                                configuredRate:
                                    zz.rate,

                                configuredBehavior:
                                    zz.behaviorText ||
                                    zz.behaviorValue,

                                taxId:
                                    zz.taxId,

                                taxName:
                                    zz.taxText
                            }
                        ],

                        requiresSelection:
                            false
                    };
                }


                if (zzCandidates.length > 1) {

                    log.error({
                        title:
                            'Más de una configuración ZZ',

                        details: {
                            country:
                                normalizedCountry,

                            xmlCode:
                                normalizedCode,

                            candidates:
                                zzCandidates.map(
                                    item => ({
                                        mappingId:
                                            item.mappingId,

                                        taxId:
                                            item.taxId,

                                        taxName:
                                            item.taxText
                                    })
                                )
                        }
                    });

                    /*
                     * Si hay más de uno no elegimos arbitrariamente.
                     * Dejamos que el usuario seleccione.
                     */

                    const zzOptions =
                        zzCandidates.map(
                            zz => ({

                                mappingId:
                                    zz.mappingId,

                                configuredName:
                                    zz.configuredName,

                                configuredRate:
                                    zz.rate,

                                configuredBehavior:
                                    zz.behaviorText ||
                                    zz.behaviorValue,

                                taxId:
                                    zz.taxId,

                                taxName:
                                    zz.taxText
                            })
                        );


                    return {

                        mappingId: '',
                        configuredName:
                            zzOptions[0]?.configuredName || '',

                        configuredRate:
                            zzOptions[0]?.configuredRate || '',

                        configuredBehavior:
                            zzOptions[0]?.configuredBehavior || '',

                        taxId: '',
                        taxName: '',

                        options:
                            zzOptions,

                        requiresSelection:
                            true
                    };
                }


                log.error({
                    title:
                        'ZZ sin código NetSuite configurado',

                    details: {
                        country:
                            normalizedCountry,

                        xmlCode:
                            normalizedCode
                    }
                });


                return emptyTaxConfiguration();
            }
            // ============================================================
            // MATCH EXACTO:
            // PAÍS + CÓDIGO + COMPORTAMIENTO + TASA
            // ============================================================

            let matches =
                countryCandidates.filter(
                    candidate => {

                        const sameBehavior =
                            candidate.behavior ===
                            normalizedType;


                        const sameRate =
                            Math.abs(
                                candidate.rate -
                                normalizedRate
                            ) < 0.01;


                        return (
                            sameBehavior &&
                            sameRate
                        );
                    }
                );


            // ============================================================
            // FALLBACK
            //
            // Si existe exactamente un registro del mismo país/código/tasa
            // pero el comportamiento del catálogo tiene alguna diferencia.
            // ============================================================

            if (!matches.length) {

                const rateMatches =
                    countryCandidates.filter(
                        candidate =>
                            Math.abs(
                                candidate.rate -
                                normalizedRate
                            ) < 0.01
                    );


                if (
                    rateMatches.length === 1
                ) {

                    matches =
                        rateMatches;


                    log.audit({
                        title:
                            'Configuración encontrada por fallback',

                        details: {

                            xmlCode:
                                normalizedCode,

                            requestedBehavior:
                                normalizedType,

                            configuredBehavior:
                                rateMatches[0]
                                    .behavior,

                            rate:
                                normalizedRate,

                            mappingId:
                                rateMatches[0]
                                    .mappingId
                        }
                    });
                }
            }


            // ============================================================
            // SIN MATCH
            // ============================================================

            if (!matches.length) {

                log.error({
                    title:
                        'No existe configuración fiscal compatible',

                    details: {

                        country:
                            normalizedCountry,

                        xmlCode:
                            normalizedCode,

                        behavior:
                            normalizedType,

                        rate:
                            normalizedRate,

                        candidates:
                            countryCandidates
                                .map(
                                    item => ({

                                        mappingId:
                                            item.mappingId,

                                        country:
                                            item.countryText,

                                        behavior:
                                            item.behavior,

                                        rate:
                                            item.rate,

                                        taxId:
                                            item.taxId,

                                        taxText:
                                            item.taxText
                                    })
                                )
                    }
                });


                return emptyTaxConfiguration();
            }


            // ============================================================
            // OPCIONES
            // ============================================================

            const options = [];


            const usedTaxIds =
                new Set();


            matches.forEach(
                candidate => {

                    if (
                        !candidate.taxId
                    ) {
                        return;
                    }


                    /*
                     * Si varios registros apuntan al mismo Tax Code,
                     * mostramos una sola alternativa.
                     */
                    if (
                        usedTaxIds.has(
                            String(
                                candidate.taxId
                            )
                        )
                    ) {

                        return;
                    }


                    usedTaxIds.add(
                        String(
                            candidate.taxId
                        )
                    );


                    options.push({

                        mappingId:
                            candidate.mappingId,

                        configuredName:
                            candidate.configuredName,

                        configuredRate:
                            candidate.rate,

                        configuredBehavior:
                            candidate.behaviorText ||
                            candidate.behaviorValue,

                        taxId:
                            candidate.taxId,

                        taxName:
                            candidate.taxText
                    });
                }
            );


            if (!options.length) {

                return emptyTaxConfiguration();
            }


            // ============================================================
            // 1 OPCIÓN = AUTOMÁTICA
            // MÁS DE 1 = USUARIO SELECCIONA
            // ============================================================

            const selected =
                options.length === 1
                    ? options[0]
                    : null;


            log.audit({
                title:
                    'Resultado configuración fiscal',

                details: {

                    country:
                        normalizedCountry,

                    xmlCode:
                        normalizedCode,

                    behavior:
                        normalizedType,

                    rate:
                        normalizedRate,

                    options,

                    selected
                }
            });


            return {

                mappingId:
                    selected
                        ? selected.mappingId
                        : '',


                configuredName:
                    selected
                        ? selected.configuredName
                        : options[0].configuredName,


                configuredRate:
                    selected
                        ? selected.configuredRate
                        : options[0].configuredRate,


                configuredBehavior:
                    selected
                        ? selected.configuredBehavior
                        : options[0].configuredBehavior,


                taxId:
                    selected
                        ? selected.taxId
                        : '',


                taxName:
                    selected
                        ? selected.taxName
                        : '',


                options,

                requiresSelection:
                    options.length > 1
            };
        } catch (functionError) {
            logFunctionError('findConfiguredTaxCode', functionError);
            throw functionError;
        }
    };


    const getManualTaxMetadata = (countryCode, taxId) => {
        try {

            const normalizedCountry =
                cleanText(countryCode).toUpperCase();

            const normalizedTaxId =
                cleanText(taxId);

            if (!normalizedCountry || !normalizedTaxId) {
                return null;
            }

            const expectedCountryName =
                CONFIG.COUNTRY[normalizedCountry]
                    ? CONFIG.COUNTRY[normalizedCountry].name
                    : normalizedCountry;

            const normalizeText = value => {
                try {
                    return cleanText(value)
                        .toUpperCase()
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '');
                } catch (functionError) {
                    logFunctionError('getManualTaxMetadata.normalizeText', functionError);
                    throw functionError;
                }
            };

            const expectedCountry =
                normalizeText(expectedCountryName);

            const results = search.create({
                type: CONFIG.TAX_MAPPING.RECORD,
                filters: [
                    [CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE, 'anyof', normalizedTaxId],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: [
                    'internalid',
                    CONFIG.TAX_MAPPING.COUNTRY,
                    CONFIG.TAX_MAPPING.XML_CODE,
                    CONFIG.TAX_MAPPING.BEHAVIOR,
                    CONFIG.TAX_MAPPING.TAX_NAME,
                    CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE,
                    CONFIG.TAX_MAPPING.RATE
                ]
            }).run().getRange({
                start: 0,
                end: 100
            });

            const candidates = results.map(result => {

                const countryText =
                    result.getText({
                        name: CONFIG.TAX_MAPPING.COUNTRY
                    }) || '';

                if (
                    normalizeText(countryText) !==
                    expectedCountry
                ) {
                    return null;
                }

                const behaviorText =
                    result.getText({
                        name: CONFIG.TAX_MAPPING.BEHAVIOR
                    }) || '';

                const behaviorValue =
                    result.getValue({
                        name: CONFIG.TAX_MAPPING.BEHAVIOR
                    }) || '';

                return {
                    mappingId:
                        result.getValue({
                            name: 'internalid'
                        }) || '',

                    authorityCode:
                        result.getValue({
                            name: CONFIG.TAX_MAPPING.XML_CODE
                        }) || 'MANUAL',

                    type:
                        normalizeTaxType(
                            behaviorText ||
                            behaviorValue
                        ),

                    rate:
                        normalizeTaxRate(
                            result.getValue({
                                name: CONFIG.TAX_MAPPING.RATE
                            }),
                            normalizedCountry
                        ),

                    name:
                        result.getText({
                            name: CONFIG.TAX_MAPPING.TAX_NAME
                        }) ||
                        result.getValue({
                            name: CONFIG.TAX_MAPPING.TAX_NAME
                        }) ||
                        '',

                    taxId:
                        normalizedTaxId,

                    taxName:
                        result.getText({
                            name: CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE
                        }) || ''
                };
            }).filter(Boolean);


            const uniqueDefinitions = [];
            const used = new Set();

            candidates.forEach(item => {

                const key = [
                    item.type,
                    item.rate
                ].join('|');

                if (!used.has(key)) {
                    used.add(key);
                    uniqueDefinitions.push(item);
                }
            });


            if (!uniqueDefinitions.length) {
                throw new Error(
                    `El código de impuesto NetSuite ${normalizedTaxId} ` +
                    `no tiene una configuración fiscal activa para ${expectedCountryName}.`
                );
            }


            if (uniqueDefinitions.length > 1) {
                throw new Error(
                    `El código de impuesto NetSuite ${normalizedTaxId} tiene más de una ` +
                    `configuración fiscal para ${expectedCountryName}.`
                );
            }


            const selected =
                uniqueDefinitions[0];


            if (
                !selected.type
            ) {
                throw new Error(
                    `No fue posible determinar el comportamiento fiscal del código ` +
                    `${selected.taxName || normalizedTaxId}.`
                );
            }


            if (
                selected.rate <= 0 &&
                !['EXEMPT', 'UNAFFECTED'].includes(
                    selected.type
                )
            ) {
                throw new Error(
                    `El código de impuesto ${selected.taxName || normalizedTaxId} ` +
                    `no tiene una tasa válida configurada.`
                );
            }


            return selected;
        } catch (functionError) {
            logFunctionError('getManualTaxMetadata', functionError);
            throw functionError;
        }
    };


    const appendManualTaxes = (
        countryCode,
        taxes,
        manualTaxes
    ) => {
        try {

            const target =
                Array.isArray(taxes)
                    ? taxes
                    : [];

            (manualTaxes || []).forEach(
                (manual, index) => {

                    const taxId =
                        cleanText(
                            manual.taxId
                        );

                    /*
                     * En una línea manual el usuario captura la BASE,
                     * no el importe final del impuesto.
                     *
                     * manual.amount se conserva como fallback de compatibilidad
                     * con pantallas anteriores.
                     */
                    const taxableAmount =
                        Math.abs(
                            toNumber(
                                manual.base !== undefined &&
                                    manual.base !== null &&
                                    manual.base !== ''
                                    ? manual.base
                                    : manual.amount
                            )
                        );


                    if (!taxId && !taxableAmount) {
                        return;
                    }


                    if (!taxId) {
                        throw new Error(
                            `La línea manual de impuesto ${index + 1} no tiene código de impuesto NetSuite.`
                        );
                    }


                    if (taxableAmount <= 0) {
                        throw new Error(
                            `La línea manual de impuesto ${index + 1} debe tener una base mayor a cero.`
                        );
                    }


                    const metadata =
                        getManualTaxMetadata(
                            countryCode,
                            taxId
                        );


                    const rate =
                        toNumber(
                            metadata.rate
                        );


                    const amount =
                        ['EXEMPT', 'UNAFFECTED'].includes(
                            metadata.type
                        )
                            ? 0
                            : Number(
                                (
                                    taxableAmount *
                                    (rate / 100)
                                ).toFixed(2)
                            );


                    log.audit({
                        title: 'Impuesto manual calculado',
                        details: {
                            countryCode,
                            taxId: metadata.taxId,
                            taxName: metadata.taxName,
                            type: metadata.type,
                            rate,
                            taxableAmount,
                            calculatedAmount: amount
                        }
                    });


                    target.push({
                        type:
                            metadata.type,

                        authorityCode:
                            metadata.authorityCode ||
                            'MANUAL',

                        name:
                            metadata.name ||
                            metadata.taxName ||
                            'Impuesto manual',

                        rate,

                        originalRate:
                            String(rate),

                        taxableAmount,

                        amount,

                        taxId:
                            metadata.taxId,

                        taxName:
                            metadata.taxName,

                        mappingId:
                            metadata.mappingId,

                        taxOptions:
                            [],

                        requiresTaxSelection:
                            false,

                        manual:
                            true
                    });
                }
            );


            return target;
        } catch (functionError) {
            logFunctionError('appendManualTaxes', functionError);
            throw functionError;
        }
    };


    const enrichAndGroupTaxes = (countryCode, taxes) => {
        try {

            const grouped = {};

            (taxes || []).forEach(tax => {

                const type =
                    normalizeTaxType(
                        tax.type
                    );

                const authorityCode =
                    cleanText(
                        tax.authorityCode
                    ).toUpperCase();

                const normalizedRate =
                    normalizeTaxRate(
                        tax.rate,
                        countryCode
                    );

                const taxData =
                    findConfiguredTaxCode(
                        countryCode,
                        authorityCode,
                        type,
                        normalizedRate
                    );


                const enriched = {

                    type,

                    authorityCode,

                    name:
                        taxData.configuredName ||
                        tax.name ||
                        '',

                    rate:
                        normalizedRate,

                    originalRate:
                        String(
                            tax.rate ?? ''
                        ),

                    taxableAmount:
                        toNumber(
                            tax.taxableAmount
                        ),

                    amount:
                        toNumber(
                            tax.amount
                        ),

                    taxId:
                        taxData.taxId,

                    taxName:
                        taxData.taxName,

                    mappingId:
                        taxData.mappingId,

                    taxOptions:
                        taxData.options || [],

                    requiresTaxSelection:
                        Boolean(
                            taxData.requiresSelection
                        )
                };


                const key = [

                    enriched.type,

                    enriched.authorityCode,

                    enriched.rate,

                    enriched.taxId

                ].join('|');


                if (!grouped[key]) {

                    grouped[key] = {
                        ...enriched,
                        taxableAmount: 0,
                        amount: 0
                    };
                }


                grouped[key].taxableAmount +=
                    enriched.taxableAmount;

                grouped[key].amount +=
                    enriched.amount;
            });


            return Object.values(
                grouped
            );
        } catch (functionError) {
            logFunctionError('enrichAndGroupTaxes', functionError);
            throw functionError;
        }
    };
    // -------------------------------------------------------------------------
    // Adaptador México - CFDI 4.0
    // -------------------------------------------------------------------------

    const MX_NS = {
        cfdi: 'http://www.sat.gob.mx/cfd/4',
        tfd: 'http://www.sat.gob.mx/TimbreFiscalDigital'
    };

    const parseMexico = document => {
        try {
            const comprobante = selectFirst(document, '//cfdi:Comprobante', MX_NS);
            if (!comprobante) {
                throw new Error('No se encontró cfdi:Comprobante de CFDI 4.0.');
            }

            const emisor = selectFirst(document, '//cfdi:Emisor', MX_NS);
            const receptor = selectFirst(document, '//cfdi:Receptor', MX_NS);
            const timbre = selectFirst(document, '//tfd:TimbreFiscalDigital', MX_NS);

            if (!emisor || !receptor || !timbre) {
                throw new Error('El CFDI no contiene Emisor, Receptor o Timbre Fiscal Digital.');
            }

            const paymentForm = getAttributeAny(comprobante, ['FormaPago']);
            const paymentMethod = getAttributeAny(comprobante, ['MetodoPago']);

            const validPayment =
                (paymentForm === '99' && paymentMethod === 'PPD') ||
                (paymentForm === '03' && paymentMethod === 'PUE');

            if (!validPayment) {
                throw new Error(
                    `Combinación FormaPago/MetodoPago no permitida: ${paymentForm || 'N/A'} / ${paymentMethod || 'N/A'}. ` +
                    'Se permite 99 + PPD o 03 + PUE.'
                );
            }

            // Número visible del comprobante mexicano: Serie + Folio.
            const serie = cleanText(getAttributeAny(comprobante, ['Serie']));
            const folio = cleanText(getAttributeAny(comprobante, ['Folio']));
            const documentNumber = [serie, folio].filter(Boolean).join('');
            const uuid = cleanText(getAttributeAny(timbre, ['UUID']));

            const taxes = [];

            selectNodes(document, '//cfdi:Traslado[@TasaOCuota]', MX_NS).forEach(node => {
                taxes.push({
                    type: 'TRANSFER',
                    authorityCode: getAttributeAny(node, ['Impuesto']),
                    name: 'Traslado',
                    rate: getAttributeAny(node, ['TasaOCuota']),
                    amount: getAttributeAny(node, ['Importe'])
                });
            });

            selectNodes(document, '//cfdi:Retencion[@TasaOCuota]', MX_NS).forEach(node => {
                taxes.push({
                    type: 'WITHHOLDING',
                    authorityCode: getAttributeAny(node, ['Impuesto']),
                    name: 'Retención',
                    rate: getAttributeAny(node, ['TasaOCuota']),
                    amount: getAttributeAny(node, ['Importe'])
                });
            });

            return {
                countryCode: 'MX',
                countryName: CONFIG.COUNTRY.MX.name,
                // Identificador fiscal único.
                documentId: uuid || documentNumber,
                // Número que debe ir en N° Referencia / tranid.
                documentNumber: documentNumber || uuid,
                issueDate: getAttributeAny(comprobante, ['Fecha']),
                currencyCode: getAttributeAny(comprobante, ['Moneda']),
                subtotal: toNumber(getAttributeAny(comprobante, ['SubTotal'])),
                total: toNumber(getAttributeAny(comprobante, ['Total'])),
                supplierTaxId: getAttributeAny(emisor, ['Rfc']),
                supplierName: getAttributeAny(emisor, ['Nombre']),
                customerTaxId: getAttributeAny(receptor, ['Rfc']),
                paymentForm,
                paymentMethod,
                taxes
            };
        } catch (functionError) {
            logFunctionError('parseMexico', functionError);
            throw functionError;
        }
    };

    // -------------------------------------------------------------------------
    // Adaptadores UBL - Perú y Colombia
    // -------------------------------------------------------------------------

    const parseUblParty = (document, partyType) => {
        try {

            const isSupplier =
                partyType === 'supplier';

            const root =
                isSupplier
                    ? 'AccountingSupplierParty'
                    : 'AccountingCustomerParty';

            const rootPath =
                `//*[local-name()='${root}']`;

            const partyPath =
                rootPath + `/*[local-name()='Party']`;


            const identificationNode =
                selectFirst(
                    document,
                    partyPath +
                    `/*[local-name()='PartyIdentification']` +
                    `/*[local-name()='ID']`
                );


            const companyIdNode =
                selectFirst(
                    document,
                    partyPath +
                    `/*[local-name()='PartyTaxScheme']` +
                    `/*[local-name()='CompanyID']`
                );


            const identificationTaxId =
                nodeText(
                    identificationNode
                );


            const documentTypeCode =
                cleanText(
                    getAttributeAny(
                        identificationNode,
                        ['schemeID']
                    ) ||
                    getAttributeAny(
                        companyIdNode,
                        ['schemeName']
                    )
                );


            const documentTypeName =
                cleanText(
                    getAttributeAny(
                        identificationNode,
                        ['schemeName']
                    )
                );


            const taxId =
                nodeText(companyIdNode) ||
                firstText(document, [
                    rootPath + `/*[local-name()='CustomerAssignedAccountID']`
                ]) ||
                identificationTaxId;


            const legalName =
                firstText(document, [
                    partyPath +
                    `/*[local-name()='PartyLegalEntity']` +
                    `/*[local-name()='RegistrationName']`,

                    partyPath +
                    `/*[local-name()='PartyTaxScheme']` +
                    `/*[local-name()='RegistrationName']`
                ]);


            const commercialName =
                firstText(document, [
                    partyPath +
                    `/*[local-name()='PartyName']` +
                    `/*[local-name()='Name']`
                ]) ||
                legalName;


            const verificationDigit =
                cleanText(
                    getAttributeAny(
                        companyIdNode,
                        ['schemeID']
                    )
                );


            const addressBasePaths = [
                partyPath + `/*[local-name()='PostalAddress']`,
                partyPath +
                `/*[local-name()='PhysicalLocation']` +
                `/*[local-name()='Address']`
            ];


            const getAddressText = childPath => {
                try {
                    return firstText(
                        document,
                        addressBasePaths.map(base =>
                            base + childPath
                        )
                    );
                } catch (functionError) {
                    logFunctionError('parseUblParty.getAddressText', functionError);
                    throw functionError;
                }
            };


            const countryCode =
                getAddressText(
                    `/*[local-name()='Country']` +
                    `/*[local-name()='IdentificationCode']`
                );


            const countryName =
                getAddressText(
                    `/*[local-name()='Country']` +
                    `/*[local-name()='Name']`
                );


            const stateCode =
                getAddressText(
                    `/*[local-name()='CountrySubentityCode']`
                );


            const stateName =
                getAddressText(
                    `/*[local-name()='CountrySubentity']`
                );


            const cityCode =
                getAddressText(
                    `/*[local-name()='ID']`
                );


            const cityName =
                getAddressText(
                    `/*[local-name()='CityName']`
                );


            const postalCode =
                getAddressText(
                    `/*[local-name()='PostalZone']`
                );


            const contributorType =
                firstText(document, [
                    rootPath +
                    `/*[local-name()='AdditionalAccountID']`,

                    partyPath +
                    `/*[local-name()='AdditionalAccountID']`
                ]);


            const fiscalRegime =
                firstText(document, [
                    partyPath +
                    `/*[local-name()='PartyTaxScheme']` +
                    `/*[local-name()='TaxScheme']` +
                    `/*[local-name()='Name']`
                ]);


            const fiscalResponsibility =
                firstText(document, [
                    partyPath +
                    `/*[local-name()='PartyTaxScheme']` +
                    `/*[local-name()='TaxLevelCode']`
                ]);


            const economicActivity =
                firstText(document, [
                    partyPath +
                    `/*[local-name()='PartyLegalEntity']` +
                    `/*[local-name()='CorporateRegistrationScheme']` +
                    `/*[local-name()='ID']`,

                    partyPath +
                    `/*[local-name()='PartyLegalEntity']` +
                    `/*[local-name()='CorporateRegistrationScheme']` +
                    `/*[local-name()='Name']`
                ]);


            return {
                taxId,
                name:
                    legalName ||
                    commercialName,

                legalName,
                commercialName,

                schemeID:
                    documentTypeCode,

                documentTypeCode,
                documentTypeName,

                verificationDigit,

                countryCode,
                countryName,

                stateCode,
                stateName,

                cityCode,
                cityName,

                postalCode,

                contributorType,
                fiscalRegime,
                fiscalResponsibility,
                economicActivity
            };
        } catch (functionError) {
            logFunctionError('parseUblParty', functionError);
            throw functionError;
        }
    };

    const parseUblTaxSubtotal = (subtotalNode, forcedType = '') => {
        try {
            const amountNode = selectFirst(
                subtotalNode,
                "./*[local-name()='TaxAmount']"
            );

            const percentNode = selectFirst(
                subtotalNode,
                ".//*[local-name()='TaxCategory']/*[local-name()='Percent']"
            );

            const taxableAmountNode = selectFirst(
                subtotalNode,
                "./*[local-name()='TaxableAmount']"
            );

            const idNode = selectFirst(
                subtotalNode,
                ".//*[local-name()='TaxCategory']" +
                "/*[local-name()='TaxScheme']" +
                "/*[local-name()='ID']"
            );

            const nameNode = selectFirst(
                subtotalNode,
                ".//*[local-name()='TaxCategory']" +
                "/*[local-name()='TaxScheme']" +
                "/*[local-name()='Name']"
            );

            const authorityCode = nodeText(idNode).toUpperCase();
            const taxName = nodeText(nameNode);
            const taxAmount = toNumber(nodeText(amountNode));
            const taxableAmount = toNumber(nodeText(taxableAmountNode));
            const xmlRate = normalizeTaxRate(nodeText(percentNode), 'UBL');

            // Algunos XML SUNAT informan Percent como 0 o lo omiten a nivel global.
            // Cuando existe base e importe, se calcula la tasa efectiva.
            const calculatedRate =
                (!xmlRate && taxableAmount > 0 && taxAmount > 0)
                    ? Number(
                        (
                            Math.round(
                                ((taxAmount / taxableAmount) * 100) * 100
                            ) / 100
                        ).toFixed(2)
                    )
                    : xmlRate;

            let type = forcedType;

            if (!type) {
                if (['05', '06', '07', 'ZZ', 'RET', 'WITHHOLDING'].includes(authorityCode) ||
                    /RET|WITHHOLD/i.test(taxName)) {
                    type = 'WITHHOLDING';
                } else if (authorityCode === '9997' || /EXONERAD/i.test(taxName)) {
                    type = 'EXEMPT';
                } else if (authorityCode === '9998' || /INAFECT/i.test(taxName)) {
                    type = 'UNAFFECTED';
                } else if (/DETRACC/i.test(authorityCode) || /DETRACC/i.test(taxName)) {
                    type = 'DETRACTION';
                } else {
                    type = 'TRANSFER';
                }
            }

            return {
                type,
                authorityCode,
                name: taxName,
                rate: calculatedRate,
                originalRate: nodeText(percentNode),
                taxableAmount,
                amount: taxAmount
            };
        } catch (functionError) {
            logFunctionError('parseUblTaxSubtotal', functionError);
            throw functionError;
        }
    };

    const parseUblTaxes = document => {
        try {

            const taxes = [];

            const processedNodes = new Set();

            /*
             * N/xml puede devolver wrappers distintos para el mismo nodo
             * entre ejecuciones XPath. Por eso un Set basado sólo en la
             * identidad del objeto no es suficiente para evitar que el
             * fallback vuelva a agregar la misma retención.
             *
             * Esta colección deduplica por los datos fiscales reales.
             */
            const processedTaxKeys = new Set();


            // ============================================================
            // HELPER
            // Saber si el impuesto pertenece a nivel factura
            // y no a InvoiceLine
            // ============================================================

            const isGlobalTaxNode = node => {
                try {

                    if (!node) {
                        return false;
                    }

                    let current =
                        node.parentNode;

                    while (current) {

                        const localName =
                            cleanText(
                                current.localName ||
                                current.nodeName
                            ).replace(/^.*:/, '');


                        // Impuesto de línea: ignorar
                        if (
                            localName === 'InvoiceLine'
                        ) {
                            return false;
                        }


                        // Llegamos al Invoice principal
                        if (
                            localName === 'Invoice'
                        ) {
                            return true;
                        }


                        current =
                            current.parentNode;
                    }

                    return false;
                } catch (functionError) {
                    logFunctionError('parseUblTaxes.isGlobalTaxNode', functionError);
                    throw functionError;
                }
            };


            // ============================================================
            // HELPER
            // AGREGAR TAX SUBTOTAL
            // ============================================================

            const addTaxSubtotal = (
                subtotalNode,
                forcedType = ''
            ) => {
                try {

                    if (!subtotalNode) {
                        return;
                    }


                    if (
                        processedNodes.has(
                            subtotalNode
                        )
                    ) {
                        return;
                    }


                    processedNodes.add(
                        subtotalNode
                    );


                    const tax =
                        parseUblTaxSubtotal(
                            subtotalNode,
                            forcedType
                        );


                    if (
                        !tax ||
                        !tax.authorityCode
                    ) {
                        return;
                    }


                    /*
                     * Evitar duplicados semánticos.
                     *
                     * El fallback vuelve a consultar TaxSubtotal mediante otro XPath.
                     * En SuiteScript/N/xml esos nodos pueden no conservar la misma
                     * identidad de objeto, por lo que processedNodes.has(...) puede
                     * fallar aunque sea el mismo nodo XML.
                     */
                    const taxKey = [
                        cleanText(tax.type).toUpperCase(),
                        cleanText(tax.authorityCode).toUpperCase(),
                        Number(toNumber(tax.rate).toFixed(6)),
                        Number(toNumber(tax.taxableAmount).toFixed(6)),
                        Number(toNumber(tax.amount).toFixed(6))
                    ].join('|');


                    if (
                        processedTaxKeys.has(
                            taxKey
                        )
                    ) {

                        log.debug({
                            title:
                                'UBL - Impuesto duplicado omitido',

                            details: {
                                taxKey,
                                forcedType,
                                authorityCode:
                                    tax.authorityCode,
                                rate:
                                    tax.rate,
                                taxableAmount:
                                    tax.taxableAmount,
                                amount:
                                    tax.amount
                            }
                        });

                        return;
                    }


                    processedTaxKeys.add(
                        taxKey
                    );


                    /*
                     * Colombia:
                     *
                     * 05 = ReteIVA
                     * 06 = ReteRenta
                     * 07 = ReteICA
                     *
                     * Aunque algunos XML los coloquen en TaxTotal,
                     * se consideran retenciones.
                     */
                    if (
                        ['05', '06', '07', 'ZZ'].includes(
                            tax.authorityCode
                        )
                    ) {

                        tax.type =
                            'WITHHOLDING';
                    }


                    log.audit({
                        title:
                            'UBL - Impuesto detectado',

                        details: {
                            type:
                                tax.type,

                            authorityCode:
                                tax.authorityCode,

                            name:
                                tax.name,

                            rate:
                                tax.rate,

                            originalRate:
                                tax.originalRate,

                            taxableAmount:
                                tax.taxableAmount,

                            amount:
                                tax.amount
                        }
                    });


                    taxes.push(
                        tax
                    );
                } catch (functionError) {
                    logFunctionError('parseUblTaxes.addTaxSubtotal', functionError);
                    throw functionError;
                }
            };


            // ============================================================
            // 1. TAX TOTAL
            // ============================================================

            const taxTotals =
                selectNodes(
                    document,
                    "//*[local-name()='TaxTotal']"
                );


            log.audit({
                title:
                    'UBL - TaxTotal encontrados',

                details: {
                    cantidad:
                        taxTotals.length
                }
            });


            taxTotals.forEach(
                taxTotal => {

                    if (
                        !isGlobalTaxNode(
                            taxTotal
                        )
                    ) {
                        return;
                    }


                    const subtotals =
                        selectNodes(
                            taxTotal,
                            "./*[local-name()='TaxSubtotal']"
                        );


                    subtotals.forEach(
                        subtotal => {

                            addTaxSubtotal(
                                subtotal
                            );
                        }
                    );
                }
            );


            // ============================================================
            // 2. WITHHOLDING TAX TOTAL
            // ============================================================

            const withholdingTotals =
                selectNodes(
                    document,
                    "//*[local-name()='WithholdingTaxTotal']"
                );


            log.audit({
                title:
                    'UBL - WithholdingTaxTotal encontrados',

                details: {
                    cantidad:
                        withholdingTotals.length
                }
            });


            withholdingTotals.forEach(
                withholdingTotal => {

                    if (
                        !isGlobalTaxNode(
                            withholdingTotal
                        )
                    ) {
                        return;
                    }


                    const subtotals =
                        selectNodes(
                            withholdingTotal,
                            "./*[local-name()='TaxSubtotal']"
                        );


                    subtotals.forEach(
                        subtotal => {

                            addTaxSubtotal(
                                subtotal,
                                'WITHHOLDING'
                            );
                        }
                    );
                }
            );


            // ============================================================
            // 3. FALLBACK PARA RETENCIONES
            //
            // Algunos XML no colocan la retención exactamente donde
            // esperamos. Buscamos todos los TaxSubtotal fuera de líneas.
            // ============================================================

            const allSubtotals =
                selectNodes(
                    document,
                    "//*[local-name()='TaxSubtotal']"
                );


            allSubtotals.forEach(
                subtotal => {

                    if (
                        processedNodes.has(
                            subtotal
                        )
                    ) {
                        return;
                    }


                    if (
                        !isGlobalTaxNode(
                            subtotal
                        )
                    ) {
                        return;
                    }


                    const candidate =
                        parseUblTaxSubtotal(
                            subtotal
                        );


                    if (!candidate) {
                        return;
                    }


                    const code =
                        cleanText(
                            candidate.authorityCode
                        ).toUpperCase();


                    const name =
                        cleanText(
                            candidate.name
                        ).toUpperCase();


                    const isRetention =
                        ['05', '06', '07', 'ZZ'].includes(
                            code
                        ) ||
                        /RETE|RETENC|WITHHOLD/.test(
                            name
                        );


                    if (!isRetention) {
                        return;
                    }


                    addTaxSubtotal(
                        subtotal,
                        'WITHHOLDING'
                    );
                }
            );


            // ============================================================
            // 4. DIAGNÓSTICO
            // ============================================================

            const taxSchemeIds =
                selectNodes(
                    document,
                    "//*[local-name()='TaxScheme']" +
                    "/*[local-name()='ID']"
                );


            const retentionCodes =
                [];


            taxSchemeIds.forEach(
                node => {

                    const code =
                        nodeText(node)
                            .toUpperCase();


                    if (
                        ['05', '06', '07'].includes(
                            code
                        )
                    ) {

                        retentionCodes.push(
                            code
                        );
                    }
                }
            );


            log.audit({
                title:
                    'UBL - Códigos de retención encontrados',

                details: {
                    codes:
                        retentionCodes
                }
            });


            log.audit({
                title:
                    'UBL - Impuestos finales XML',

                details:
                    taxes
            });


            return taxes;
        } catch (functionError) {
            logFunctionError('parseUblTaxes', functionError);
            throw functionError;
        }
    };

    /**
     * SUNAT normalmente informa la detracción en PaymentTerms,
     * no dentro de TaxTotal.
     */
    const parsePeruDetraction = document => {
        try {
            const paymentTerms = selectNodes(
                document,
                "/*[local-name()='Invoice']/*[local-name()='PaymentTerms']"
            );

            for (const node of paymentTerms) {
                const id = firstText(node, [
                    "./*[local-name()='ID']"
                ]).toUpperCase();

                const paymentMeansId = firstText(node, [
                    "./*[local-name()='PaymentMeansID']"
                ]);

                const percent = firstText(node, [
                    "./*[local-name()='PaymentPercent']"
                ]);

                const amount = firstText(node, [
                    "./*[local-name()='Amount']"
                ]);

                if (
                    id.includes('DETRACC') ||
                    paymentMeansId.includes('DETRACC') ||
                    (percent && amount && id === 'FORMA_PAGO')
                ) {
                    return {
                        type: 'DETRACTION',
                        authorityCode: 'DETRACCION',
                        name: 'DETRACCIÓN',
                        rate: percent,
                        amount
                    };
                }
            }

            return null;
        } catch (functionError) {
            logFunctionError('parsePeruDetraction', functionError);
            throw functionError;
        }
    };

    const parsePeru = document => {
        try {
            const supplier = parseUblParty(document, 'supplier');
            const customer = parseUblParty(document, 'customer');

            const seriesNumber = firstText(document, [
                "/*[local-name()='Invoice']/*[local-name()='ID']"
            ]);

            const uuid = firstText(document, [
                "/*[local-name()='Invoice']/*[local-name()='UUID']"
            ]);

            return {
                countryCode: 'PE',
                countryName: CONFIG.COUNTRY.PE.name,
                documentId: uuid || seriesNumber,
                documentNumber: seriesNumber || uuid,
                issueDate: firstText(document, ["/*[local-name()='Invoice']/*[local-name()='IssueDate']"]),
                currencyCode: firstText(document, ["/*[local-name()='Invoice']/*[local-name()='DocumentCurrencyCode']"]),
                subtotal: toNumber(firstText(document, [
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='LineExtensionAmount']",
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='TaxExclusiveAmount']"
                ])),
                total: toNumber(firstText(document, [
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='PayableAmount']",
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='TaxInclusiveAmount']"
                ])),
                schemeID:
                    supplier.schemeID,
                supplierTaxId: supplier.taxId,
                supplierName: supplier.name,
                customerTaxId: customer.taxId,
                supplierDocumentTypeCode:
                    supplier.documentTypeCode,
                taxes: (() => {
                    const taxes = parseUblTaxes(document);
                    const detraction = parsePeruDetraction(document);
                    if (detraction) taxes.push(detraction);
                    return taxes;
                })()
            };
        } catch (functionError) {
            logFunctionError('parsePeru', functionError);
            throw functionError;
        }
    };

    const parseColombia = document => {
        try {
            const supplier = parseUblParty(document, 'supplier');
            const customer = parseUblParty(document, 'customer');

            const invoiceNumber = firstText(document, [
                "/*[local-name()='Invoice']/*[local-name()='ID']"
            ]);

            const cufe = firstText(document, [
                "/*[local-name()='Invoice']/*[local-name()='UUID']",
                "//*[local-name()='DianExtensions']//*[local-name()='UUID']"
            ]);

            return {
                countryCode: 'CO',
                countryName: CONFIG.COUNTRY.CO.name,
                documentId: cufe || invoiceNumber,
                documentNumber: invoiceNumber || cufe,
                issueDate: firstText(document, ["/*[local-name()='Invoice']/*[local-name()='IssueDate']"]),
                currencyCode: firstText(document, ["/*[local-name()='Invoice']/*[local-name()='DocumentCurrencyCode']"]),
                subtotal: toNumber(firstText(document, [
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='LineExtensionAmount']",
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='TaxExclusiveAmount']"
                ])),
                total: toNumber(firstText(document, [
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='PayableAmount']",
                    "//*[local-name()='LegalMonetaryTotal']/*[local-name()='TaxInclusiveAmount']"
                ])),
                supplierTaxId: supplier.taxId,
                supplierName: supplier.name,
                customerTaxId: customer.taxId,

                supplierLegalName:
                    supplier.legalName,

                supplierCommercialName:
                    supplier.commercialName,

                supplierDocumentTypeCode:
                    supplier.documentTypeCode,

                supplierDocumentTypeName:
                    supplier.documentTypeName,

                supplierVerificationDigit:
                    supplier.verificationDigit,

                supplierCountryCode:
                    supplier.countryCode,

                supplierCountryName:
                    supplier.countryName,

                supplierStateCode:
                    supplier.stateCode,

                supplierStateName:
                    supplier.stateName,

                supplierCityCode:
                    supplier.cityCode,

                supplierCityName:
                    supplier.cityName,

                supplierPostalCode:
                    supplier.postalCode,

                supplierContributorType:
                    supplier.contributorType,

                supplierFiscalRegime:
                    supplier.fiscalRegime,

                supplierFiscalResponsibility:
                    supplier.fiscalResponsibility,

                supplierEconomicActivity:
                    supplier.economicActivity,

                /*
                 * Regla Colombia:
                 * ZZ: Otros tributos, tasas, contribuciones y similares
                 * NO se toma automáticamente del XML.
                 *
                 * Si realmente se requiere un impuesto adicional, el usuario
                 * puede agregarlo manualmente desde la interfaz.
                 */
                taxes:
                    parseUblTaxes(document)
                        .filter(tax => {

                            const authorityCode =
                                cleanText(
                                    tax.authorityCode
                                ).toUpperCase();


                            if (
                                authorityCode ===
                                'ZZ'
                            ) {

                                log.audit({
                                    title:
                                        'Colombia - impuesto ZZ omitido',

                                    details: {
                                        authorityCode:
                                            tax.authorityCode,

                                        name:
                                            tax.name,

                                        rate:
                                            tax.rate,

                                        amount:
                                            tax.amount,

                                        taxableAmount:
                                            tax.taxableAmount
                                    }
                                });

                                return false;
                            }


                            return true;
                        })
            };
        } catch (functionError) {
            logFunctionError('parseColombia', functionError);
            throw functionError;
        }
    };

    const COUNTRY_ADAPTERS = {
        MX: parseMexico,
        PE: parsePeru,
        CO: parseColombia
    };

    const detectCountry = document => {
        try {

            const root = document?.documentElement;

            const rootName = cleanText(
                root?.localName ||
                root?.nodeName
            ).replace(/^.*:/, '');

            const namespace = cleanText(
                root?.namespaceURI
            ).toLowerCase();

            const customizationId = firstText(document, [
                "/*[local-name()='Invoice']/*[local-name()='CustomizationID']"
            ]).toUpperCase();

            const profileId = firstText(document, [
                "/*[local-name()='Invoice']/*[local-name()='ProfileID']"
            ]).toUpperCase();

            const countryCode = firstText(document, [
                "//*[local-name()='DianExtensions']" +
                "//*[local-name()='InvoiceSource']" +
                "/*[local-name()='IdentificationCode']",

                "//*[local-name()='AccountingSupplierParty']" +
                "//*[local-name()='Country']" +
                "/*[local-name()='IdentificationCode']"
            ]).toUpperCase();

            // México
            if (
                rootName === 'Comprobante' ||
                namespace.includes('sat.gob.mx')
            ) {
                return 'MX';
            }

            // Colombia
            if (
                rootName === 'AttachedDocument' ||
                customizationId.includes('DIAN') ||
                profileId.includes('DIAN') ||
                namespace.includes('dian.gov.co') ||
                namespace.includes('dian:gov:co') ||
                countryCode === 'CO'
            ) {
                return 'CO';
            }

            // Perú
            if (
                rootName === 'Invoice' &&
                (
                    customizationId.includes('SUNAT') ||
                    profileId.includes('SUNAT') ||
                    countryCode === 'PE'
                )
            ) {
                return 'PE';
            }

            /*
             * Último recurso para UBL:
             * el RUC peruano normalmente tiene 11 dígitos.
             */
            if (rootName === 'Invoice') {

                const supplierTaxId =
                    parseUblParty(document, 'supplier').taxId;

                if (/^\d{11}$/.test(normalizeTaxId(supplierTaxId))) {
                    return 'PE';
                }
            }

            throw new Error(
                `No se pudo identificar el XML. Nodo raíz detectado: ${rootName || 'desconocido'}.`
            );
        } catch (functionError) {
            logFunctionError('detectCountry', functionError);
            throw functionError;
        }
    };

    /**
 * Si el XML de Colombia viene como AttachedDocument,
 * extrae la factura Invoice que está dentro del CDATA.
 */
    const unwrapElectronicInvoice = xmlText => {
        try {

            const originalText = cleanText(xmlText);

            if (!originalText) {
                throw new Error('El XML está vacío.');
            }

            /*
             * Algunos archivos copiados desde navegador incluyen esta frase
             * antes del XML. La eliminamos si existe.
             */
            const sanitizedText = originalText.replace(
                /^This XML file does not appear to have any style information associated with it\.\s*The document tree is shown below\.\s*/i,
                ''
            );

            const outerDocument = xml.Parser.fromString({
                text: sanitizedText
            });

            const root = outerDocument?.documentElement;

            const rootName = cleanText(
                root?.localName ||
                root?.nodeName
            ).replace(/^.*:/, '');

            /*
             * México, Perú o Colombia con Invoice directo.
             */
            if (
                rootName === 'Comprobante' ||
                rootName === 'Invoice'
            ) {
                return {
                    xmlText: sanitizedText,
                    document: outerDocument,
                    wasWrapped: false
                };
            }

            /*
             * Colombia DIAN puede entregar AttachedDocument.
             */
            if (rootName !== 'AttachedDocument') {
                return {
                    xmlText: sanitizedText,
                    document: outerDocument,
                    wasWrapped: false
                };
            }

            const descriptionNodes = selectNodes(
                outerDocument,
                "//*[local-name()='Attachment']" +
                "/*[local-name()='ExternalReference']" +
                "/*[local-name()='Description']"
            );

            for (const descriptionNode of descriptionNodes) {

                let embeddedXml = cleanText(
                    descriptionNode.textContent ||
                    descriptionNode.text ||
                    ''
                );

                if (!embeddedXml) {
                    continue;
                }

                /*
                 * Buscamos específicamente el XML Invoice.
                 * El AttachedDocument también puede contener
                 * un ApplicationResponse.
                 */
                const invoiceStart = embeddedXml.search(
                    /<(?:(?:\w+):)?Invoice(?:\s|>)/i
                );

                if (invoiceStart < 0) {
                    continue;
                }

                embeddedXml = embeddedXml.substring(invoiceStart);

                const invoiceEndMatch = embeddedXml.match(
                    /<\/(?:(?:\w+):)?Invoice\s*>/i
                );

                if (!invoiceEndMatch) {
                    continue;
                }

                embeddedXml = embeddedXml.substring(
                    0,
                    invoiceEndMatch.index +
                    invoiceEndMatch[0].length
                );

                /*
                 * Por si el contenido fue escapado como &lt;Invoice&gt;.
                 */
                embeddedXml = embeddedXml
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&amp;/g, '&');

                const invoiceDocument = xml.Parser.fromString({
                    text: embeddedXml
                });

                const invoiceRootName = cleanText(
                    invoiceDocument?.documentElement?.localName ||
                    invoiceDocument?.documentElement?.nodeName
                ).replace(/^.*:/, '');

                if (invoiceRootName === 'Invoice') {
                    return {
                        xmlText: embeddedXml,
                        document: invoiceDocument,
                        wasWrapped: true
                    };
                }
            }

            throw new Error(
                'El archivo es un AttachedDocument de Colombia, pero no se encontró la factura Invoice dentro del adjunto.'
            );
        } catch (functionError) {
            logFunctionError('unwrapElectronicInvoice', functionError);
            throw functionError;
        }
    };

    const parseElectronicInvoice = xmlText => {
        try {

            const unwrapped = unwrapElectronicInvoice(xmlText);
            const document = unwrapped.document;

            let detectedCountry;

            /*
             * Un AttachedDocument con una factura embebida
             * corresponde al formato DIAN de Colombia.
             */
            if (unwrapped.wasWrapped) {
                detectedCountry = 'CO';
            } else {
                detectedCountry = detectCountry(document);
            }

            const parser = COUNTRY_ADAPTERS[detectedCountry];

            if (!parser) {
                throw new Error(
                    `No existe un adaptador configurado para el país ${detectedCountry}.`
                );
            }

            const data = parser(document);

            if (!data.documentId) {
                throw new Error(
                    'No se encontró UUID, CUFE o número único del comprobante.'
                );
            }

            if (!data.supplierTaxId) {
                throw new Error(
                    'No se encontró la identificación fiscal del proveedor.'
                );
            }

            if (!data.customerTaxId) {
                throw new Error(
                    'No se encontró la identificación fiscal del receptor.'
                );
            }

            if (!data.total) {
                throw new Error(
                    'No se encontró el total del comprobante.'
                );
            }

            // Identificador fiscal único: UUID / CUFE / equivalente.
            data.documentId = cleanText(data.documentId).toUpperCase();

            // Número visible del comprobante: Folio / cbc:ID.
            // Si un XML excepcionalmente no lo informa, se usa documentId como respaldo.
            data.documentNumber = cleanText(
                data.documentNumber || data.documentId
            ).toUpperCase();

            // ============================================================
            // FECHA DE EMISIÓN DEL XML
            // ============================================================

            data.issueDate =
                normalizeIssueDate(
                    data.issueDate
                );


            if (!data.issueDate) {

                throw new Error(
                    'No se encontró una fecha de emisión válida en el XML.'
                );
            }


            log.audit({
                title: 'Fecha de emisión del comprobante',
                details: {
                    countryCode:
                        data.countryCode,

                    documentNumber:
                        data.documentNumber,

                    issueDate:
                        data.issueDate
                }
            });

            if (!data.documentNumber) {
                throw new Error(
                    'No se encontró el número de factura del comprobante.'
                );
            }

            log.audit({
                title: 'Identificadores del comprobante',
                details: {
                    countryCode: data.countryCode,
                    documentNumber: data.documentNumber,
                    documentId: data.documentId
                }
            });

            data.supplierTaxId = normalizeTaxId(data.supplierTaxId);
            data.customerTaxId = normalizeTaxId(data.customerTaxId);

            data.taxes = enrichAndGroupTaxes(data.countryCode, data.taxes);
            data.sourceWasWrapped = unwrapped.wasWrapped;

            return data;
        } catch (functionError) {
            logFunctionError('parseElectronicInvoice', functionError);
            throw functionError;
        }
    };

    // -------------------------------------------------------------------------
    // Búsquedas NetSuite
    // -------------------------------------------------------------------------

    const findDuplicateBill = (documentId, documentNumber = '') => {
        try {
            const fiscalId = cleanText(documentId).toUpperCase();
            const referenceNumber = cleanText(documentNumber || documentId).toUpperCase();

            if (!fiscalId && !referenceNumber) {
                return null;
            }

            const identityFilters = [];

            if (referenceNumber) {
                identityFilters.push(['tranid', 'is', referenceNumber]);
            }

            if (fiscalId) {
                if (identityFilters.length) identityFilters.push('OR');
                identityFilters.push(['custbody_cfdi_uuid', 'is', fiscalId]);
            }

            const results = search.create({
                type: search.Type.VENDOR_BILL,
                filters: [
                    ['mainline', 'is', 'T'],
                    'AND',
                    identityFilters
                ],
                columns: ['internalid', 'transactionnumber', 'tranid']
            }).run().getRange({ start: 0, end: 1 });

            return results.length
                ? {
                    id: results[0].getValue('internalid'),
                    transactionNumber: results[0].getValue('transactionnumber'),
                    referenceNumber: results[0].getValue('tranid')
                }
                : null;
        } catch (functionError) {
            logFunctionError('findDuplicateBill', functionError);
            throw functionError;
        }
    };

    const findSubsidiary = customerTaxId => {
        try {
            const results = search.create({
                type: search.Type.SUBSIDIARY,
                filters: [
                    ['taxregistrationnumber', 'is', customerTaxId],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: ['internalid', 'country', 'name']
            }).run().getRange({ start: 0, end: 1 });

            if (!results.length) return null;

            return {
                id: results[0].getValue('internalid'),
                countryCode: results[0].getValue('country'),
                name: results[0].getValue('name')
            };
        } catch (functionError) {
            logFunctionError('findSubsidiary', functionError);
            throw functionError;
        }
    };

    const findVendor = (countryCode, supplierTaxId) => {

        const normalizedCountry =
            cleanText(countryCode).toUpperCase();

        const normalizedTaxId =
            normalizeTaxId(supplierTaxId);

        const allowedCountries = [
            'CO',
            'PE',
            'MX'
        ];

        if (!normalizedTaxId) {
            return null;
        }

        if (!allowedCountries.includes(normalizedCountry)) {
            throw new Error(
                `No existe configuración para buscar proveedores del país ${normalizedCountry}.`
            );
        }

        /*
         * Ejecuta la búsqueda sobre la sublista Registros fiscales.
         *
         * La primera ejecución intenta coincidencia exacta por número.
         * Si no encuentra resultados, se ejecuta un fallback que revisa
         * los registros fiscales de CO, PE y MX y compara el valor
         * normalizado para tolerar puntos, guiones y espacios.
         */
        const runVendorTaxSearch = includeExactTaxFilter => {
            try {

                const filters = [
                    [
                        'taxregistration.nexuscountry',
                        'anyof',
                        ...allowedCountries
                    ],
                    'AND',
                    [
                        'isinactive',
                        'is',
                        'F'
                    ]
                ];

                if (includeExactTaxFilter) {
                    filters.splice(
                        2,
                        0,
                        [
                            'taxregistration.taxregistrationnumber',
                            'is',
                            normalizedTaxId
                        ],
                        'AND'
                    );
                }

                const vendorSearchObj = search.create({
                    type: search.Type.VENDOR,
                    filters,
                    columns: [
                        search.createColumn({
                            name: 'internalid'
                        }),
                        search.createColumn({
                            name: 'entityid'
                        }),
                        search.createColumn({
                            name: 'companyname'
                        }),
                        search.createColumn({
                            name: 'nexuscountry',
                            join: 'taxRegistration'
                        }),
                        search.createColumn({
                            name: 'taxregistrationnumber',
                            join: 'taxRegistration'
                        })
                    ]
                });

                const pagedData = vendorSearchObj.runPaged({
                    pageSize: 1000
                });

                log.audit({
                    title: includeExactTaxFilter
                        ? 'Búsqueda proveedor por registro fiscal'
                        : 'Fallback proveedor por registro fiscal',
                    details: {
                        countryCode: normalizedCountry,
                        supplierTaxId: normalizedTaxId,
                        resultCount: pagedData.count,
                        nexusCountries: allowedCountries
                    }
                });

                const matchesByVendor = {};

                pagedData.pageRanges.forEach(pageRange => {

                    const page = pagedData.fetch({
                        index: pageRange.index
                    });

                    page.data.forEach(result => {

                        const vendorId =
                            result.getValue({
                                name: 'internalid'
                            });

                        const registrationNumber =
                            result.getValue({
                                name: 'taxregistrationnumber',
                                join: 'taxRegistration'
                            }) || '';

                        const registrationCountry =
                            cleanText(
                                result.getValue({
                                    name: 'nexuscountry',
                                    join: 'taxRegistration'
                                })
                            ).toUpperCase();

                        /*
                         * La existencia del proveedor se valida exclusivamente
                         * con el RFC/RUC/NIT extraído del XML.
                         */
                        if (
                            normalizeTaxId(registrationNumber) !==
                            normalizedTaxId
                        ) {
                            return;
                        }

                        if (!vendorId) {
                            return;
                        }

                        matchesByVendor[String(vendorId)] = {
                            vendorId: String(vendorId),
                            entityId:
                                result.getValue({
                                    name: 'entityid'
                                }) || '',
                            companyName:
                                result.getValue({
                                    name: 'companyname'
                                }) || '',
                            registrationCountry,
                            registrationNumber
                        };
                    });
                });

                return Object.values(matchesByVendor);
            } catch (functionError) {
                logFunctionError('findVendor.runVendorTaxSearch', functionError);
                throw functionError;
            }
        };


        // ============================================================
        // BÚSQUEDA ADICIONAL POR custentity_gd_documento
        // ============================================================
        const runVendorGdDocumentSearch = () => {
            try {

                const results =
                    search.create({
                        type: search.Type.VENDOR,
                        filters: [
                            [
                                'custentity_gd_documento',
                                'is',
                                normalizedTaxId
                            ],
                            'AND',
                            [
                                'isinactive',
                                'is',
                                'F'
                            ]
                        ],
                        columns: [
                            'internalid',
                            'entityid',
                            'companyname',
                            'custentity_gd_documento'
                        ]
                    })
                        .run()
                        .getRange({
                            start: 0,
                            end: 100
                        });


                const matchesByVendor = {};


                results.forEach(result => {

                    const vendorId =
                        result.getValue('internalid');

                    const gdDocumento =
                        result.getValue(
                            'custentity_gd_documento'
                        ) || '';


                    if (
                        normalizeTaxId(gdDocumento) !==
                        normalizedTaxId
                    ) {
                        return;
                    }


                    if (!vendorId) {
                        return;
                    }


                    matchesByVendor[
                        String(vendorId)
                    ] = {
                        vendorId:
                            String(vendorId),

                        entityId:
                            result.getValue(
                                'entityid'
                            ) || '',

                        companyName:
                            result.getValue(
                                'companyname'
                            ) || '',

                        registrationCountry:
                            '',

                        registrationNumber:
                            '',

                        gdDocumento,

                        source:
                            'GD_DOCUMENTO'
                    };
                });


                const matches =
                    Object.values(
                        matchesByVendor
                    );


                log.audit({
                    title:
                        'Búsqueda proveedor por GD DOCUMENTO',

                    details: {
                        countryCode:
                            normalizedCountry,

                        supplierTaxId:
                            normalizedTaxId,

                        fieldId:
                            'custentity_gd_documento',

                        resultCount:
                            matches.length,

                        vendorIds:
                            matches.map(
                                item =>
                                    item.vendorId
                            )
                    }
                });


                return matches;
            } catch (functionError) {
                logFunctionError('findVendor.runVendorGdDocumentSearch', functionError);
                throw functionError;
            }
        };

        try {

            let taxMatches =
                runVendorTaxSearch(true);

            if (!taxMatches.length) {
                taxMatches =
                    runVendorTaxSearch(false);
            }


            /*
             * Búsqueda adicional solicitada:
             * custentity_gd_documento = supplierTaxId
             */
            const gdMatches =
                runVendorGdDocumentSearch();


            /*
             * Unificamos ambos orígenes por Internal ID para evitar que
             * el mismo proveedor aparezca dos veces si coincide tanto en
             * Registros fiscales como en GD DOCUMENTO.
             */
            const matchesByVendor = {};


            taxMatches.forEach(item => {

                matchesByVendor[
                    String(item.vendorId)
                ] = {
                    ...item,
                    gdDocumento:
                        '',
                    sources: [
                        'TAX_REGISTRATION'
                    ]
                };
            });


            gdMatches.forEach(item => {

                const key =
                    String(item.vendorId);


                if (matchesByVendor[key]) {

                    matchesByVendor[
                        key
                    ].gdDocumento =
                        item.gdDocumento;

                    matchesByVendor[
                        key
                    ].sources =
                        [
                            ...new Set([
                                ...(
                                    matchesByVendor[
                                        key
                                    ].sources || []
                                ),
                                'GD_DOCUMENTO'
                            ])
                        ];

                } else {

                    matchesByVendor[
                        key
                    ] = {
                        ...item,
                        sources: [
                            'GD_DOCUMENTO'
                        ]
                    };
                }
            });


            const matches =
                Object.values(
                    matchesByVendor
                );


            log.audit({
                title:
                    'Resultado combinado búsqueda proveedor',

                details: {
                    countryCode:
                        normalizedCountry,

                    supplierTaxId:
                        normalizedTaxId,

                    porRegistroFiscal:
                        taxMatches.map(
                            item =>
                                item.vendorId
                        ),

                    porGdDocumento:
                        gdMatches.map(
                            item =>
                                item.vendorId
                        ),

                    resultados:
                        matches.map(
                            item => ({
                                vendorId:
                                    item.vendorId,

                                sources:
                                    item.sources,

                                nexusCountry:
                                    item.registrationCountry,

                                taxRegistrationNumber:
                                    item.registrationNumber,

                                gdDocumento:
                                    item.gdDocumento
                            })
                        )
                }
            });


            if (!matches.length) {

                log.audit({
                    title:
                        'Proveedor no encontrado por identificación fiscal',

                    details: {
                        countryCode:
                            normalizedCountry,

                        supplierTaxId:
                            normalizedTaxId,

                        camposBuscados: [
                            'taxregistration.taxregistrationnumber',
                            'custentity_gd_documento'
                        ]
                    }
                });

                return null;
            }


            /*
             * Si existe coincidencia en Registros fiscales del mismo país,
             * mantiene prioridad. Si no, la coincidencia por GD DOCUMENTO
             * también se considera válida.
             */
            const sameCountryMatches =
                matches.filter(
                    item =>
                        item.registrationCountry ===
                        normalizedCountry
                );


            const selectedMatches =
                sameCountryMatches.length
                    ? sameCountryMatches
                    : matches;


            if (selectedMatches.length > 1) {

                throw new Error(
                    `Se encontró más de un proveedor con identificación fiscal ` +
                    `${normalizedTaxId}. IDs: ` +
                    selectedMatches
                        .map(
                            item =>
                                item.vendorId
                        )
                        .join(', ')
                );
            }


            const selected =
                selectedMatches[0];


            log.audit({
                title:
                    'Proveedor encontrado por identificación fiscal',

                details: {
                    vendorId:
                        selected.vendorId,

                    entityId:
                        selected.entityId,

                    companyName:
                        selected.companyName,

                    countryCodeXML:
                        normalizedCountry,

                    supplierTaxIdXML:
                        normalizedTaxId,

                    nexusCountry:
                        selected.registrationCountry,

                    taxRegistrationNumber:
                        selected.registrationNumber,

                    gdDocumento:
                        selected.gdDocumento,

                    foundBy:
                        selected.sources
                }
            });


            return selected.vendorId;

        } catch (error) {

            log.error({
                title:
                    'Error buscando proveedor por identificación fiscal',

                details: {
                    countryCode:
                        normalizedCountry,

                    supplierTaxId:
                        normalizedTaxId,

                    message:
                        error.message,

                    stack:
                        error.stack
                }
            });


            throw new Error(
                `No fue posible validar el proveedor con identificación fiscal ` +
                `${normalizedTaxId}: ${error.message}`
            );
        }
    };

    const getSubsidiaryIdsByCountry = countryCode => {
        try {
            const ids = [];
            search.create({
                type: search.Type.SUBSIDIARY,
                filters: [
                    ['country', 'anyof', countryCode],
                    'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: ['internalid']
            }).run().each(result => {
                ids.push(result.getValue('internalid'));
                return true;
            });
            return ids;
        } catch (functionError) {
            logFunctionError('getSubsidiaryIdsByCountry', functionError);
            throw functionError;
        }
    };

    const getBrandOptionsByCountry = countryCode => {
        try {

            const normalizedCountry =
                cleanText(countryCode).toUpperCase();

            const subsidiaryIds =
                getSubsidiaryIdsByCountry(normalizedCountry);

            if (!subsidiaryIds.length) {

                log.error({
                    title: 'Sin subsidiarias para filtrar marcas',
                    details: {
                        countryCode: normalizedCountry
                    }
                });

                return [];
            }

            const options = [];
            const usedIds = new Set();

            const brandSearch = search.create({
                type: 'customrecord_marca',

                filters: [
                    [
                        'custrecord_marca_subsidiaria_operacion',
                        'anyof',
                        subsidiaryIds
                    ],
                    'AND',
                    [
                        'isinactive',
                        'is',
                        'F'
                    ]
                ],

                columns: [
                    search.createColumn({
                        name: 'internalid'
                    }),

                    search.createColumn({
                        name: 'name',
                        sort: search.Sort.ASC
                    }),

                    search.createColumn({
                        name: 'custrecord_marca_subsidiaria_operacion'
                    })
                ]
            });

            brandSearch.run().each(result => {

                const brandId =
                    result.getValue({
                        name: 'internalid'
                    });

                if (
                    !brandId ||
                    usedIds.has(String(brandId))
                ) {
                    return true;
                }

                usedIds.add(String(brandId));

                options.push({
                    value: String(brandId),
                    text:
                        result.getValue({
                            name: 'name'
                        }) || String(brandId)
                });

                return true;
            });

            log.audit({
                title: 'Marcas filtradas por país',
                details: {
                    countryCode: normalizedCountry,
                    subsidiaryIds,
                    brandCount: options.length
                }
            });

            return options;
        } catch (functionError) {
            logFunctionError('getBrandOptionsByCountry', functionError);
            throw functionError;
        }
    };

    const getBrandSegmentId = brandId => {
        if (!brandId) return null;
        try {
            const data = search.lookupFields({
                type: 'customrecord_marca',
                id: brandId,
                columns: [CONFIG.FIELDS.BRAND_SEGMENT_SOURCE]
            });
            return data[CONFIG.FIELDS.BRAND_SEGMENT_SOURCE]?.[0]?.value || null;
        } catch (error) {
            log.error('Error obteniendo segmento de marca', error);
            return null;
        }
    };

    const getVendorCurrencies = vendorId => {
        try {
            if (!vendorId) return [];
            const vendor = record.load({ type: record.Type.VENDOR, id: vendorId });
            const values = [];
            const count = vendor.getLineCount({ sublistId: 'currency' });

            for (let line = 0; line < count; line++) {
                const id = vendor.getSublistValue({ sublistId: 'currency', fieldId: 'currency', line });
                if (!id) continue;
                const currency = search.lookupFields({ type: 'currency', id, columns: ['name', 'symbol'] });
                values.push({ id, name: currency.name || currency.symbol || String(id) });
            }

            return {
                values,
                primary: vendor.getValue('currency')
            };
        } catch (functionError) {
            logFunctionError('getVendorCurrencies', functionError);
            throw functionError;
        }
    };

    // -------------------------------------------------------------------------
    // Archivos y proveedor
    // -------------------------------------------------------------------------

    const saveUploadedFile = (uploadedFile, fileType) => {
        try {
            return file.create({
                name: uploadedFile.name,
                fileType,
                contents: uploadedFile.getContents(),
                folder: CONFIG.FILE_FOLDER_ID
            }).save();
        } catch (functionError) {
            logFunctionError('saveUploadedFile', functionError);
            throw functionError;
        }
    };

    const addVendorTaxRegistration = (
        vendorRecord,
        countryCode,
        taxRegistrationNumber
    ) => {

        const normalizedCountry = cleanText(countryCode).toUpperCase();
        const normalizedTaxId = normalizeTaxId(taxRegistrationNumber);

        if (!normalizedCountry) {
            throw new Error(
                'No se recibió el país para crear el registro fiscal del proveedor.'
            );
        }

        if (!normalizedTaxId) {
            throw new Error(
                `No se recibió una identificación fiscal válida para ${normalizedCountry}.`
            );
        }

        try {
            vendorRecord.selectNewLine({
                sublistId: 'taxregistration'
            });

            vendorRecord.setCurrentSublistValue({
                sublistId: 'taxregistration',
                fieldId: 'nexuscountry',
                value: normalizedCountry,
                forceSyncSourcing: true
            });

            vendorRecord.setCurrentSublistValue({
                sublistId: 'taxregistration',
                fieldId: 'taxregistrationnumber',
                value: normalizedTaxId,
                forceSyncSourcing: true
            });

            vendorRecord.commitLine({
                sublistId: 'taxregistration'
            });

            log.debug({
                title: 'Registro fiscal agregado',
                details: {
                    countryCode: normalizedCountry,
                    taxRegistrationNumber: normalizedTaxId
                }
            });

        } catch (error) {
            log.error({
                title: 'Error agregando registro fiscal',
                details: {
                    countryCode: normalizedCountry,
                    taxRegistrationNumber: normalizedTaxId,
                    message: error.message,
                    stack: error.stack
                }
            });

            throw new Error(
                `No fue posible agregar la identificación fiscal ` +
                `${normalizedTaxId} para el país ${normalizedCountry}: ` +
                `${error.message}`
            );
        }
    };
    const updateVendorTaxInformation = (vendorId, data) => {
        try {

            const vendor = record.load({
                type: record.Type.VENDOR,
                id: vendorId,
                isDynamic: true
            });

            const countryCode = cleanText(data.countryCode).toUpperCase();
            const supplierTaxId = normalizeTaxId(data.supplierTaxId);

            // México
            if (countryCode === 'MX') {
                vendor.setValue({
                    fieldId: 'custentity_mx_rfc',
                    value: supplierTaxId
                });
            }

            // Revisar si ya existe el registro fiscal
            const count = vendor.getLineCount({
                sublistId: 'taxregistration'
            });

            let exists = false;

            for (let i = 0; i < count; i++) {

                const nexus = vendor.getSublistValue({
                    sublistId: 'taxregistration',
                    fieldId: 'nexuscountry',
                    line: i
                });

                if (cleanText(nexus).toUpperCase() === countryCode) {

                    vendor.selectLine({
                        sublistId: 'taxregistration',
                        line: i
                    });

                    vendor.setCurrentSublistValue({
                        sublistId: 'taxregistration',
                        fieldId: 'taxregistrationnumber',
                        value: supplierTaxId
                    });

                    vendor.commitLine({
                        sublistId: 'taxregistration'
                    });

                    exists = true;
                    break;
                }
            }

            if (!exists) {
                addVendorTaxRegistration(
                    vendor,
                    countryCode,
                    supplierTaxId
                );
            }

            vendor.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            return vendorId;
        } catch (functionError) {
            logFunctionError('updateVendorTaxInformation', functionError);
            throw functionError;
        }
    };

    const getTipoDocumentoPeru = codigoDocumento => {
        try {

            const codigo =
                cleanText(codigoDocumento);

            log.audit({ title: 'Búsqueda tipo documento Perú - código SUNAT', details: codigo });

            if (!codigo) {
                throw new Error(
                    'El XML de Perú no contiene el schemeID del tipo de documento.'
                );
            }


            const customrecord_gd_tipo_de_documentoSearchObj =
                search.create({

                    type:
                        'customrecord_gd_tipo_de_documento',

                    filters: [
                        [
                            'custrecord53',
                            'is',
                            codigo
                        ]
                    ],

                    columns: [

                        search.createColumn({
                            name: 'internalid'
                        }),

                        search.createColumn({
                            name: 'name',
                            label: 'Nombre'
                        }),

                        search.createColumn({
                            name: 'scriptid',
                            label: 'ID de script'
                        }),

                        search.createColumn({
                            name: 'custrecord_gd_codigo_tipo_documento',
                            label: 'CODIGO TIPO DOCUMENTO'
                        }),

                        search.createColumn({
                            name: 'custrecord_gd_pais_documento',
                            label: 'PAIS DOCUMENTO'
                        })
                    ]
                });


            const results =
                customrecord_gd_tipo_de_documentoSearchObj
                    .run()
                    .getRange({
                        start: 0,
                        end: 2
                    });


            log.audit({
                title:
                    'Búsqueda tipo documento Perú',

                details: {
                    codigoXML:
                        codigo,

                    resultados:
                        results.length
                }
            });


            if (!results.length) {

                throw new Error(
                    `No se encontró un tipo de documento configurado ` +
                    `para el código SUNAT ${codigo}.`
                );
            }


            if (results.length > 1) {

                throw new Error(
                    `Se encontró más de un tipo de documento ` +
                    `con el código SUNAT ${codigo}.`
                );
            }


            const result =
                results[0];


            const tipoDocumento = {

                id:
                    result.getValue({
                        name: 'internalid'
                    }),

                nombre:
                    result.getValue({
                        name: 'name'
                    }),

                codigo:
                    result.getValue({
                        name:
                            'custrecord_gd_codigo_tipo_documento'
                    }),

                pais:
                    result.getText({
                        name:
                            'custrecord_gd_pais_documento'
                    }) ||
                    result.getValue({
                        name:
                            'custrecord_gd_pais_documento'
                    })
            };


            log.audit({
                title:
                    'Tipo documento Perú encontrado',

                details:
                    tipoDocumento
            });


            return tipoDocumento.id;
        } catch (functionError) {
            logFunctionError('getTipoDocumentoPeru', functionError);
            throw functionError;
        }
    };

    const getTipoPersonaPeru = (schemeID) => {
        try {

            switch (String(schemeID)) {

                case '6':
                    return 'Persona Jurídica';

                case '1':
                    return 'Persona Natural';

                default:
                    return 'Extranjero';
            }
        } catch (functionError) {
            logFunctionError('getTipoPersonaPeru', functionError);
            throw functionError;
        }
    };

    const updateVendorPeruDocumentType = (vendorId, data) => {
        try {

            if (
                !vendorId ||
                data.countryCode !== 'PE' ||
                !data.supplierDocumentTypeCode
            ) {
                return vendorId;
            }

            const vendor = record.load({
                type: record.Type.VENDOR,
                id: vendorId,
                isDynamic: false
            });

            const currentCountry =
                vendor.getValue({
                    fieldId: 'custentity_gd_pais_documento'
                });

            const currentDocument =
                vendor.getValue({
                    fieldId: 'custentity_gd_pe_documento_identidad'
                });


            // Solo llena si está vacío
            if (!currentCountry) {
                vendor.setText({
                    fieldId: 'custentity_gd_pais_documento',
                    text: 'Peru'
                });
            }


            if (!currentDocument) {

                const tipoDocumentoId =
                    getTipoDocumentoPeru(
                        data.supplierDocumentTypeCode
                    );

                if (tipoDocumentoId) {

                    vendor.setValue({
                        fieldId:
                            'custentity_gd_pe_documento_identidad',

                        value:
                            tipoDocumentoId
                    });
                }
            }


            vendor.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });


            log.audit({
                title:
                    'Proveedor existente actualizado Perú',

                details: {
                    vendorId,
                    codigoDocumento:
                        data.supplierDocumentTypeCode,
                    campoActualizado:
                        !currentDocument
                }
            });


            return vendorId;
        } catch (functionError) {
            logFunctionError('updateVendorPeruDocumentType', functionError);
            throw functionError;
        }
    };

    function updateVendorPeruTypeOfPerson(vendorId, data) {
        try {

            if (
                !vendorId ||
                cleanText(data.countryCode).toUpperCase() !== 'PE'
            ) {
                return vendorId;
            }

            var schemeID = data.schemeID;

            if (typeof schemeID === 'object') {
                schemeID = schemeID.schemeID;
            }


            var tipoPersonaId;


            switch (String(schemeID)) {

                case "6":
                    // Persona Jurídica RUC
                    tipoPersonaId = "2";
                    break;

                case "1":
                    // Persona Natural
                    tipoPersonaId = "1";
                    break;

                default:
                    tipoPersonaId = "3";
                    break;
            }


            log.audit({
                title: "Tipo Persona Perú - ID asignado",
                details: {
                    vendorId: vendorId,
                    schemeID: schemeID,
                    internalId: tipoPersonaId
                }
            });


            var vendor = record.load({
                type: record.Type.VENDOR,
                id: vendorId
            });


            vendor.setValue({
                fieldId: "custentity_gd_pe_type_of_person",
                value: tipoPersonaId
            });

            vendor.setValue({
                fieldId: "custentity_fte_entity_l_taxregime",
                value: '4'
            });

            log.audit({
                title: "Régimen fiscal SuiteTax Latam actualizado Perú",
                details: {
                    vendorId: vendorId,
                    fieldId: "custentity_fte_entity_l_taxregime",
                    value: '4'
                }
            });


            let vendorSave = vendor.save({
                ignoreMandatoryFields: true
            });


            log.audit({
                title: "Tipo Persona Perú actualizado",
                details: {
                    vendorId: vendorId,
                    valorGuardado: tipoPersonaId
                }
            });

            return vendorSave
        } catch (functionError) {
            logFunctionError('updateVendorPeruTypeOfPerson', functionError);
            throw functionError;
        }
    }

    const getColombiaStateCandidates = stateName => {
        try {

            const raw =
                cleanText(stateName);

            const normalized =
                raw
                    .toUpperCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/[.,]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();

            const aliases = {
                'BOGOTA': [
                    'Bogotá D.C.',
                    'Bogota D.C.',
                    'Bogotá',
                    'Bogota'
                ],
                'BOGOTA DC': [
                    'Bogotá D.C.',
                    'Bogota D.C.',
                    'Bogotá',
                    'Bogota'
                ],
                'NORTE DE SANTANDER': [
                    'Norte De Santander',
                    'Norte de Santander'
                ],
                'VALLE DEL CAUCA': [
                    'Valle Del Cauca',
                    'Valle del Cauca'
                ],
                'SAN ANDRES': [
                    'San Andrés',
                    'San Andres'
                ]
            };

            return [
                ...(aliases[normalized] || []),
                raw
            ].filter(Boolean);
        } catch (functionError) {
            logFunctionError('getColombiaStateCandidates', functionError);
            throw functionError;
        }
    };


    const getColombiaCityCandidates = cityName => {
        try {

            const raw =
                cleanText(cityName);

            if (!raw) {
                return [];
            }

            /*
             * La ciudad se toma exclusivamente de cbc:CityName.
             * No usamos cbc:ID (código DANE) para seleccionar GD CIUDAD.
             *
             * Se agregan variantes sólo para tolerar diferencias de puntuación
             * del catálogo de NetSuite.
             */
            return [
                // NetSuite puede tener "Bogotá D.C." mientras DIAN envía
                // "Bogotá, D.C.". Probamos primero la variante sin coma.
                raw.replace(/,\s*/g, ' '),
                raw,
                raw.replace(/\./g, ''),
                raw.replace(/,\s*/g, ' ').replace(/\./g, '')
            ].filter(Boolean);
        } catch (functionError) {
            logFunctionError('getColombiaCityCandidates', functionError);
            throw functionError;
        }
    };


    const getColombiaDocumentTypeCandidates = code => {
        try {

            const normalized =
                cleanText(code).toUpperCase();

            const map = {
                '11': ['Registro civil'],
                '12': ['Tarjeta de identidad'],
                '13': ['Cédula de ciudadanía', 'Cedula de ciudadania'],
                '21': ['Tarjeta de extranjería', 'Tarjeta de extranjeria'],
                '22': ['Cédula de extranjería', 'Cedula de extranjeria'],
                '31': ['NIT'],
                '41': ['Pasaporte'],
                '42': ['Documento de identificación extranjero', 'Documento de identificacion extranjero'],
                '47': ['PEP'],
                '48': ['PPT'],
                '50': ['NIT de otro país', 'NIT de otro pais']
            };

            return [
                ...(map[normalized] || []),
                normalized
            ].filter(Boolean);
        } catch (functionError) {
            logFunctionError('getColombiaDocumentTypeCandidates', functionError);
            throw functionError;
        }
    };


    const setColombiaRegimenFiscal = (vendor, data) => {
        try {

            const responsibility =
                cleanText(
                    data.supplierFiscalResponsibility
                ).toUpperCase();

            const regime =
                cleanText(
                    data.supplierFiscalRegime
                )
                    .toUpperCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '');

            /*
             * Catálogo confirmado en esta cuenta:
             * 1 = Régimen Ordinario
             * 2 = Régimen Simple
             */
            let internalId = '';

            if (
                /^(?:O|0)-47$/i.test(responsibility) ||
                regime.includes('SIMPLE') ||
                regime.includes('RST')
            ) {
                internalId = '2';
            } else if (
                regime === 'IVA' ||
                regime.includes('ORDINARIO') ||
                responsibility
            ) {
                internalId = '1';
            }

            if (!internalId) {
                return false;
            }

            vendor.setValue({
                fieldId:
                    'custentity_gd_co_regimen_fiscal',
                value:
                    internalId
            });

            log.audit({
                title:
                    'Régimen fiscal Colombia asignado por ID confirmado',
                details: {
                    xmlRegime:
                        data.supplierFiscalRegime,
                    xmlResponsibility:
                        data.supplierFiscalResponsibility,
                    internalId
                }
            });

            return true;
        } catch (functionError) {
            logFunctionError('setColombiaRegimenFiscal', functionError);
            throw functionError;
        }
    };


    const setColombiaResponsabilidadFiscal = (vendor, value) => {
        try {

            const raw =
                cleanText(value);

            const normalized =
                raw
                    .toUpperCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/\s+/g, '')
                    .replace(/_/g, '-');

            /*
             * Catálogo confirmado en esta cuenta:
             * 1 = 0-13 Gran Contribuyente
             * 2 = 0-15 Autorretenedor
             * 3 = 0-23 Agente de retención IVA
             * 4 = 0-47 Régimen simple de tributación
             * 5 = R-99 PN No aplica - Otros
             */
            const map = {
                'O-13': '1',
                '0-13': '1',

                'O-15': '2',
                '0-15': '2',

                'O-23': '3',
                '0-23': '3',

                'O-47': '4',
                '0-47': '4',

                'R-99-PN': '5',
                'R-99PN': '5',
                'R-99': '5'
            };

            const internalId =
                map[normalized] || '';

            if (!internalId) {

                log.error({
                    title:
                        'Responsabilidad fiscal Colombia sin mapeo',
                    details: {
                        xmlValue:
                            raw
                    }
                });

                return false;
            }

            vendor.setValue({
                fieldId:
                    'custentity_gd_co_responsabilidad_fiscal',
                value:
                    internalId
            });

            log.audit({
                title:
                    'Responsabilidad fiscal Colombia asignada por ID confirmado',
                details: {
                    xmlValue:
                        raw,
                    internalId
                }
            });

            return true;
        } catch (functionError) {
            logFunctionError('setColombiaResponsabilidadFiscal', functionError);
            throw functionError;
        }
    };


    const getColombiaFiscalRegimeCandidates = value => {
        try {

            const raw =
                cleanText(value);

            const normalized =
                raw
                    .toUpperCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();

            /*
             * IMPORTANTE:
             * PartyTaxScheme/TaxScheme/Name en DIAN describe el impuesto
             * (por ejemplo "IVA"), no necesariamente el régimen fiscal
             * del proveedor.
             *
             * En esta cuenta NetSuite, el catálogo del campo es:
             * 1 = Régimen Ordinario
             * 2 = Régimen Simple
             *
             * Si el XML trae "IVA", no existe una equivalencia directa.
             * Para responsabilidad O-47/RST podemos inferir Régimen Simple.
             * En los demás casos usamos Régimen Ordinario como regla
             * configurable de esta implementación.
             */
            if (
                normalized.includes('SIMPLE') ||
                normalized.includes('RST')
            ) {
                return [
                    'Régimen Simple',
                    'Regimen Simple'
                ];
            }

            if (
                normalized === 'IVA' ||
                normalized.includes('ORDINARIO')
            ) {
                return [
                    'Régimen Ordinario',
                    'Regimen Ordinario'
                ];
            }

            return raw
                ? [raw]
                : [];
        } catch (functionError) {
            logFunctionError('getColombiaFiscalRegimeCandidates', functionError);
            throw functionError;
        }
    };


    const getColombiaFiscalResponsibilityCandidates = value => {
        try {

            const raw =
                cleanText(value);

            const normalized =
                raw
                    .toUpperCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/\s+/g, '')
                    .replace(/_/g, '-');

            /*
             * DIAN -> catálogo real de NetSuite.
             *
             * En varios XML DIAN el código puede venir con letra O:
             * O-13, O-15, O-23, O-47.
             *
             * El catálogo de esta cuenta está visible con cero:
             * 0-13, 0-15, 0-23, 0-47.
             */
            const map = {
                'R-99-PN': [
                    'R-99 PN No aplica - Otros*',
                    'R-99 PN No aplica - Otros',
                    'R-99 PN',
                    'R-99'
                ],
                'R-99PN': [
                    'R-99 PN No aplica - Otros*',
                    'R-99 PN No aplica - Otros',
                    'R-99 PN',
                    'R-99'
                ],

                'O-13': [
                    '0-13 - Gran Contribuyente',
                    'O-13 - Gran Contribuyente',
                    '0-13',
                    'O-13'
                ],
                '0-13': [
                    '0-13 - Gran Contribuyente',
                    '0-13'
                ],

                'O-15': [
                    '0-15 - Autorretenedor',
                    'O-15 - Autorretenedor',
                    '0-15',
                    'O-15'
                ],
                '0-15': [
                    '0-15 - Autorretenedor',
                    '0-15'
                ],

                'O-23': [
                    '0-23 - Agente de retención IVA',
                    '0-23 - Agente de retencion IVA',
                    'O-23 - Agente de retención IVA',
                    '0-23',
                    'O-23'
                ],
                '0-23': [
                    '0-23 - Agente de retención IVA',
                    '0-23 - Agente de retencion IVA',
                    '0-23'
                ],

                'O-47': [
                    '0-47 - Régimen simple de tributación',
                    '0-47 - Regimen simple de tributacion',
                    'O-47 - Régimen simple de tributación',
                    '0-47',
                    'O-47'
                ],
                '0-47': [
                    '0-47 - Régimen simple de tributación',
                    '0-47 - Regimen simple de tributacion',
                    '0-47'
                ]
            };

            return [
                ...(map[normalized] || []),
                raw
            ].filter(Boolean);
        } catch (functionError) {
            logFunctionError('getColombiaFiscalResponsibilityCandidates', functionError);
            throw functionError;
        }
    };


    const applyVendorColombiaFields = (
        vendor,
        data,
        options = {}
    ) => {
        try {

            const countryCode =
                cleanText(data.countryCode).toUpperCase();

            const updateCompanyName =
                options.updateCompanyName !== false;

            if (countryCode !== 'CO') {
                return;
            }

            const legalName =
                cleanText(
                    data.supplierLegalName ||
                    data.supplierName
                );

            const commercialName =
                cleanText(
                    data.supplierCommercialName ||
                    legalName
                );

            const documentNumber =
                normalizeTaxId(
                    data.supplierTaxId
                );

            /*
             * En proveedor EXISTENTE no modificamos companyname.
             *
             * NetSuite puede volver a generar/validar el Entity ID al cambiar
             * companyname y lanzar DUP_VENDOR_NAME aunque el proveedor correcto
             * ya haya sido localizado por NIT en taxregistration.
             *
             * El nombre legal del XML sí se usa al CREAR un proveedor nuevo.
             */
            if (
                updateCompanyName &&
                legalName
            ) {
                safeSetValue(
                    vendor,
                    'companyname',
                    legalName
                );
            }

            safeSetValue(
                vendor,
                'custentity_gd_nombre_comercial',
                commercialName
            );

            safeSetValue(
                vendor,
                'custentity_gd_documento',
                documentNumber
            );

            safeSetValue(
                vendor,
                'custentity_gd_digito_de_verificacion',
                data.supplierVerificationDigit
            );

            /*
             * País y país del documento:
             * sólo asignamos la selección Colombia.
             * NO tocamos GD CODIGO PAIS ni GD CODIGO DEL ESTADO.
             */
            setSelectByCandidates(
                vendor,
                'custentity_gd_pais',
                [
                    data.supplierCountryName,
                    'Colombia',
                    data.supplierCountryCode,
                    'CO'
                ]
            );

            setSelectByCandidates(
                vendor,
                'custentity_gd_pais_documento',
                [
                    data.supplierCountryName,
                    'Colombia',
                    data.supplierCountryCode,
                    'CO'
                ]
            );

            setSelectByCandidates(
                vendor,
                'custentity_gd_tipo_de_documento_de_ident',
                [
                    data.supplierDocumentTypeName,
                    ...getColombiaDocumentTypeCandidates(
                        data.supplierDocumentTypeCode
                    )
                ]
            );

            /*
             * Colombia:
             * - GD ESTADO  <- cbc:CountrySubentity
             * - GD CIUDAD  <- cbc:CityName
             *
             * NO usamos CountrySubentityCode ni Address/ID para seleccionar
             * estos dos campos.
             */
            setSelectByCandidates(
                vendor,
                'custentity_gd_estado',
                getColombiaStateCandidates(
                    data.supplierStateName
                )
            );

            setSelectByCandidates(
                vendor,
                'custentity_gd_ciudad',
                getColombiaCityCandidates(
                    data.supplierCityName
                )
            );

            safeSetValue(
                vendor,
                'custentity_gd_codigo_ciudad',
                data.supplierCityCode
            );

            safeSetValue(
                vendor,
                'custentity_gd_codigo_postal',
                data.supplierPostalCode
            );

            /*
             * NO asignar custentity_gd_co_tipo_de_contribuyente desde
             * cbc:AdditionalAccountID.
             *
             * En DIAN AdditionalAccountID identifica el tipo de organización
             * jurídica (1 = Persona Jurídica, 2 = Persona Natural), mientras
             * este campo NetSuite contiene clasificaciones tributarias como
             * Responsable de IVA, Régimen Simple, Gran Contribuyente, etc.
             * Son catálogos diferentes.
             */

            log.audit({
                title: 'Tipo de contribuyente Colombia no asignado automáticamente',
                details: {
                    additionalAccountId:
                        data.supplierContributorType,
                    reason:
                        'AdditionalAccountID DIAN corresponde a tipo de organización jurídica, no al catálogo GD CO Tipo de Contribuyente.'
                }
            });

            setColombiaRegimenFiscal(
                vendor,
                data
            );

            setColombiaResponsabilidadFiscal(
                vendor,
                data.supplierFiscalResponsibility
            );

            /*
             * NO asignar actividad económica desde CorporateRegistrationScheme.
             * En el XML de prueba el valor es FVP, que corresponde al prefijo
             * de facturación y no a un código CIIU.
             */
            log.audit({
                title: 'Actividad económica Colombia no asignada automáticamente',
                details: {
                    xmlValue:
                        data.supplierEconomicActivity,
                    reason:
                        'CorporateRegistrationScheme del XML analizado contiene el prefijo de facturación, no un código CIIU.'
                }
            });

            log.audit({
                title: 'Datos Colombia preparados para proveedor',
                details: {
                    legalName,
                    commercialName,
                    documentNumber,
                    verificationDigit:
                        data.supplierVerificationDigit,
                    documentTypeCode:
                        data.supplierDocumentTypeCode,
                    documentTypeName:
                        data.supplierDocumentTypeName,
                    countryCode:
                        data.supplierCountryCode,
                    stateCode:
                        data.supplierStateCode,
                    stateName:
                        data.supplierStateName,
                    cityCode:
                        data.supplierCityCode,
                    cityName:
                        data.supplierCityName,
                    postalCode:
                        data.supplierPostalCode,
                    contributorType:
                        data.supplierContributorType,
                    fiscalRegime:
                        data.supplierFiscalRegime,
                    fiscalResponsibility:
                        data.supplierFiscalResponsibility,
                    economicActivity:
                        data.supplierEconomicActivity
                }
            });
        } catch (functionError) {
            logFunctionError('applyVendorColombiaFields', functionError);
            throw functionError;
        }
    };


    const updateVendorColombia = (vendorId, data) => {
        try {

            if (
                !vendorId ||
                cleanText(data.countryCode).toUpperCase() !== 'CO'
            ) {
                return vendorId;
            }

            const vendor = record.load({
                type: record.Type.VENDOR,
                id: vendorId,
                isDynamic: false
            });

            applyVendorColombiaFields(
                vendor,
                data,
                {
                    updateCompanyName: false
                }
            );

            vendor.setValue({
                fieldId: 'custentity_fte_entity_l_taxregime',
                value: '15'
            });

            log.audit({
                title: 'Régimen fiscal SuiteTax Latam actualizado Colombia',
                details: {
                    vendorId,
                    fieldId: 'custentity_fte_entity_l_taxregime',
                    value: '15'
                }
            });


            log.audit({
                title: 'Colombia - valores antes de guardar proveedor',
                details: {
                    vendorId,
                    entityId:
                        vendor.getValue({
                            fieldId: 'entityid'
                        }),
                    companyNameActual:
                        vendor.getValue({
                            fieldId: 'companyname'
                        }),
                    companyNameXML:
                        data.supplierLegalName ||
                        data.supplierName ||
                        '',
                    pais:
                        vendor.getValue({
                            fieldId: 'custentity_gd_pais'
                        }),
                    paisDocumento:
                        vendor.getValue({
                            fieldId: 'custentity_gd_pais_documento'
                        }),
                    tipoDocumento:
                        vendor.getValue({
                            fieldId: 'custentity_gd_tipo_de_documento_de_ident'
                        }),
                    documento:
                        vendor.getValue({
                            fieldId: 'custentity_gd_documento'
                        }),
                    digitoVerificacion:
                        vendor.getValue({
                            fieldId: 'custentity_gd_digito_de_verificacion'
                        }),
                    estado:
                        vendor.getValue({
                            fieldId: 'custentity_gd_estado'
                        }),
                    ciudad:
                        vendor.getValue({
                            fieldId: 'custentity_gd_ciudad'
                        }),
                    codigoCiudad:
                        vendor.getValue({
                            fieldId: 'custentity_gd_codigo_ciudad'
                        }),
                    regimenFiscal:
                        vendor.getValue({
                            fieldId: 'custentity_gd_co_regimen_fiscal'
                        }),
                    responsabilidadFiscal:
                        vendor.getValue({
                            fieldId: 'custentity_gd_co_responsabilidad_fiscal'
                        }),
                    regimenFiscalSuiteTaxLatam:
                        vendor.getValue({
                            fieldId: 'custentity_fte_entity_l_taxregime'
                        })
                }
            });

            vendor.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.audit({
                title: 'Proveedor existente actualizado Colombia',
                details: {
                    vendorId,
                    supplierTaxId:
                        data.supplierTaxId
                }
            });

            return vendorId;
        } catch (functionError) {
            logFunctionError('updateVendorColombia', functionError);
            throw functionError;
        }
    };


    const createVendor = data => {
        try {

            const countryCode = cleanText(
                data.countryCode
            ).toUpperCase();

            const supplierTaxId = normalizeTaxId(
                data.supplierTaxId
            );

            /*
             * Antes de crear, se valida nuevamente por RFC/RUC/NIT
             * en la sublista Registros fiscales. La razón social no
             * determina si el proveedor ya existe.
             */
            const existingVendor = findVendor(
                countryCode,
                supplierTaxId
            );

            if (existingVendor) {

                log.audit({
                    title: 'Proveedor existente validado por registro fiscal',
                    details: {
                        vendorId: existingVendor,
                        countryCode,
                        supplierTaxId,
                        companyNameXML: data.supplierName
                    }
                });

                return existingVendor;
            }

            if (!['MX', 'PE', 'CO'].includes(countryCode)) {
                throw new Error(
                    `No existe configuración para crear proveedores del país ${countryCode}.`
                );
            }

            if (!supplierTaxId) {
                throw new Error(
                    'El XML no contiene una identificación fiscal válida para crear el proveedor.'
                );
            }

            if (!data.subsidiaryId) {
                throw new Error(
                    'No se pudo determinar la subsidiaria para crear el proveedor.'
                );
            }

            const vendor = record.create({
                type: record.Type.VENDOR,
                isDynamic: true
            });

            const vendorCustomForms = {
                PE: 64,
                CO: 66
            };

            const customFormId = vendorCustomForms[countryCode];

            if (customFormId) {
                vendor.setValue({
                    fieldId: 'customform',
                    value: customFormId
                });
            }

            /*
             * Datos principales.
             */
            vendor.setValue({
                fieldId: 'companyname',
                value:
                    cleanText(data.supplierName) ||
                    supplierTaxId
            });

            vendor.setValue({
                fieldId: 'subsidiary',
                value: Number(data.subsidiaryId)
            });

            /*
             * México:
             * Conservamos también el campo tradicional RFC porque la
             * localización mexicana puede seguir validándolo.
             */
            if (countryCode === 'MX') {
                vendor.setValue({
                    fieldId: 'custentity_mx_rfc',
                    value: supplierTaxId
                });

                const assignedRfc = normalizeTaxId(
                    vendor.getValue({
                        fieldId: 'custentity_mx_rfc'
                    })
                );

                if (!assignedRfc) {
                    throw new Error(
                        `No fue posible asignar el RFC ${supplierTaxId} ` +
                        'al campo custentity_mx_rfc.'
                    );
                }
            }


            // ============================================================
            // PERÚ - CAMPOS BASE DEL PROVEEDOR
            // ============================================================

            if (countryCode === 'PE') {

                vendor.setText({
                    fieldId: 'custentity_gd_pais',
                    text: 'Peru'
                });

                // ========================================================
                // TIPO DE PERSONA
                // ========================================================

                // ========================================================
                // TIPO DE PERSONA
                // ========================================================

                let tipoPersonaId = null;

                switch (String(data.schemeID)) {

                    case "6":
                        // RUC - Persona Jurídica
                        tipoPersonaId = "2";
                        break;

                    case "1":
                        // Persona Natural
                        tipoPersonaId = "1";
                        break;

                    default:
                        // Extranjero
                        tipoPersonaId = "3";
                        break;
                }


                log.audit({
                    title: 'DEBUG Tipo Persona Perú - Nuevo proveedor',
                    details: {
                        countryCode,
                        schemeID: data.schemeID,
                        tipoPersonaId
                    }
                });


                vendor.setValue({
                    fieldId: 'custentity_gd_pe_type_of_person',
                    value: tipoPersonaId
                });

                // ========================================================
                // PAÍS DEL DOCUMENTO
                // ========================================================

                vendor.setText({
                    fieldId: 'custentity_gd_pais_documento',
                    text: 'Peru'
                });

                // ========================================================
                // TIPO DE DOCUMENTO
                // ========================================================

                const tipoDocumentoId =
                    getTipoDocumentoPeru(
                        data.supplierDocumentTypeCode
                    );

                vendor.setValue({
                    fieldId: 'custentity_gd_pe_documento_identidad',
                    value: tipoDocumentoId
                });

                log.audit({
                    title: 'Datos fiscales Perú asignados al proveedor',
                    details: {
                        custentity_gd_pais: 'Peru',
                        custentity_gd_pais_documento: 'Peru',
                        schemeID: data.schemeID,
                        tipoPersonaId,
                        codigoDocumentoXML: data.supplierDocumentTypeCode,
                        tipoDocumentoInternalId: tipoDocumentoId,
                        campoTipoDocumento: 'custentity_gd_pe_documento_identidad',
                        campoTipoPersona: 'custentity_gd_pe_type_of_person'
                    }
                });
            }

            // ============================================================
            // COLOMBIA - CAMPOS DE LOCALIZACIÓN DEL PROVEEDOR
            // ============================================================

            if (countryCode === 'CO') {
                applyVendorColombiaFields(
                    vendor,
                    data,
                    {
                        updateCompanyName: true
                    }
                );
            }

            // ============================================================
            // RÉGIMEN FISCAL SUITETAX LATAM
            // ============================================================

            if (countryCode === 'CO') {
                vendor.setValue({
                    fieldId: 'custentity_fte_entity_l_taxregime',
                    value: '15'
                });

                log.audit({
                    title: 'Régimen fiscal SuiteTax Latam asignado Colombia',
                    details: {
                        fieldId: 'custentity_fte_entity_l_taxregime',
                        value: '15'
                    }
                });
            }

            if (countryCode === 'PE') {
                vendor.setValue({
                    fieldId: 'custentity_fte_entity_l_taxregime',
                    value: '4'
                });

                log.audit({
                    title: 'Régimen fiscal SuiteTax Latam asignado Perú',
                    details: {
                        fieldId: 'custentity_fte_entity_l_taxregime',
                        value: '4'
                    }
                });
            }


            /*
             * México, Perú y Colombia:
             * Agregamos la identificación en la subficha Registros fiscales.
             */
            addVendorTaxRegistration(
                vendor,
                countryCode,
                supplierTaxId
            );

            const taxRegistrationCount =
                vendor.getLineCount({
                    sublistId: 'taxregistration'
                });

            if (!taxRegistrationCount) {
                throw new Error(
                    `No se creó el registro fiscal ${supplierTaxId} ` +
                    `para el país ${countryCode}.`
                );
            }

            const vendorId = vendor.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            /*
             * Cuenta bancaria.
             */
            if (data.bankAccount) {
                const bank = record.create({
                    type: 'customrecord_ce_cue_ent',
                    isDynamic: true
                });

                safeSetValue(
                    bank,
                    'custrecord_ce_cue_ent_entidad',
                    vendorId
                );

                safeSetValue(
                    bank,
                    'custrecord_ce_cue_ent_cuenta',
                    data.bankAccount
                );

                safeSetValue(
                    bank,
                    'custrecord_ce_cue_ent_banco_nal',
                    data.bankId
                );

                bank.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: false
                });
            }

            log.audit({
                title: 'Proveedor creado',
                details: {
                    vendorId,
                    countryCode,
                    supplierTaxId,
                    subsidiaryId: data.subsidiaryId
                }
            });

            return vendorId;
        } catch (functionError) {
            logFunctionError('createVendor', functionError);
            throw functionError;
        }
    };

    // -------------------------------------------------------------------------
    // Creación de Vendor Bill
    // -------------------------------------------------------------------------

    const createVendorBill = params => {
        const invoiceData = JSON.parse(params.custpage_invoice_json || '{}');
        const countryConfig = CONFIG.COUNTRY[invoiceData.countryCode];

        const duplicate = findDuplicateBill(
            invoiceData.documentId,
            invoiceData.documentNumber
        );
        if (duplicate) {
            throw new Error(`El comprobante ya existe en la factura ${duplicate.transactionNumber}.`);
        }

        const isNewVendor =
            params.custpage_proveedor_nuevo === 'T';

        let vendorId =
            params.custpage_vendorid;

        if (isNewVendor) {

            vendorId = createVendor({
                countryCode: invoiceData.countryCode,
                supplierName: invoiceData.supplierName,
                supplierTaxId: invoiceData.supplierTaxId,
                supplierDocumentTypeCode: invoiceData.supplierDocumentTypeCode,
                supplierDocumentTypeName: invoiceData.supplierDocumentTypeName,
                supplierLegalName: invoiceData.supplierLegalName,
                supplierCommercialName: invoiceData.supplierCommercialName,
                supplierVerificationDigit: invoiceData.supplierVerificationDigit,
                supplierCountryCode: invoiceData.supplierCountryCode,
                supplierCountryName: invoiceData.supplierCountryName,
                supplierStateCode: invoiceData.supplierStateCode,
                supplierStateName: invoiceData.supplierStateName,
                supplierCityCode: invoiceData.supplierCityCode,
                supplierCityName: invoiceData.supplierCityName,
                supplierPostalCode: invoiceData.supplierPostalCode,
                supplierContributorType: invoiceData.supplierContributorType,
                supplierFiscalRegime: invoiceData.supplierFiscalRegime,
                supplierFiscalResponsibility: invoiceData.supplierFiscalResponsibility,
                supplierEconomicActivity: invoiceData.supplierEconomicActivity,
                schemeID: invoiceData.schemeID,
                subsidiaryId: params.custpage_subsidiaria,
                bankAccount: params.custpage_cuenta_bancaria,
                bankId: params.custpage_banco
            });
        } else if (vendorId) {

            /*
             * El proveedor ya fue localizado por su RFC/RUC/NIT.
             *
             * No permitimos que un problema de nombre duplicado en el
             * maestro de proveedores impida crear la factura.
             *
             * Cada actualización conserva su comportamiento normal;
             * únicamente DUP_VENDOR_NAME se registra y se omite.
             */
            vendorId =
                executeExistingVendorUpdate(
                    'Actualización de registro fiscal',
                    () =>
                        updateVendorTaxInformation(
                            vendorId,
                            {
                                countryCode:
                                    invoiceData.countryCode,

                                supplierName:
                                    invoiceData.supplierName,

                                supplierTaxId:
                                    invoiceData.supplierTaxId
                            }
                        ),
                    vendorId
                );


            vendorId =
                executeExistingVendorUpdate(
                    'Actualización de tipo documento Perú',
                    () =>
                        updateVendorPeruDocumentType(
                            vendorId,
                            {
                                countryCode:
                                    invoiceData.countryCode,

                                supplierDocumentTypeCode:
                                    invoiceData.supplierDocumentTypeCode
                            }
                        ),
                    vendorId
                );


            vendorId =
                executeExistingVendorUpdate(
                    'Actualización de tipo persona Perú',
                    () =>
                        updateVendorPeruTypeOfPerson(
                            vendorId,
                            {
                                countryCode:
                                    invoiceData.countryCode,

                                schemeID:
                                    invoiceData.schemeID
                            }
                        ),
                    vendorId
                );


            vendorId =
                executeExistingVendorUpdate(
                    'Actualización de proveedor Colombia',
                    () =>
                        updateVendorColombia(
                            vendorId,
                            invoiceData
                        ),
                    vendorId
                );


            log.audit({
                title:
                    'Proveedor existente preparado para factura',

                details: {
                    vendorId,
                    companyName:
                        invoiceData.supplierName,
                    countryCode:
                        invoiceData.countryCode,
                    supplierTaxId:
                        invoiceData.supplierTaxId
                }
            });
        }

        if (!vendorId) throw new Error('No se pudo determinar el proveedor.');

        // ============================================================
        // DISTRIBUCIÓN MULTI-LÍNEA
        // ============================================================

        const originalTaxes =
            JSON.parse(
                params.custpage_taxes_json ||
                '[]'
            );


        /*
         * Tipo de línea elegido en el planificador:
         * ITEMS    -> sublista item (proceso de artículos).
         * EXPENSES -> sublista expense (proceso original por categoría).
         */
        const lineMode =
            cleanText(
                params.custpage_tipo_linea
            ).toUpperCase();


        if (!['ITEMS', 'EXPENSES'].includes(lineMode)) {

            throw new Error(
                'Selecciona si la factura se registrará por artículos o por gastos.'
            );
        }


        const isItemMode =
            lineMode === 'ITEMS';


        let expenseDistribution = [];

        try {

            const parsedDistribution =
                JSON.parse(
                    params.custpage_expense_distribution_json ||
                    '[]'
                );


            expenseDistribution =
                Array.isArray(
                    parsedDistribution
                )
                    ? parsedDistribution
                    : [];

        } catch (error) {

            throw new Error(
                'La distribución de líneas e impuestos contiene información inválida.'
            );
        }


        if (!expenseDistribution.length) {

            throw new Error(
                isItemMode
                    ? 'Debes agregar al menos un artículo.'
                    : 'Debes agregar al menos una categoría de gasto.'
            );
        }


        const buildLineTaxes =
            (distributionLine, lineIndex) => {
                try {

                    const sourceTaxes =
                        Array.isArray(
                            distributionLine.taxes
                        )
                            ? distributionLine.taxes
                            : [];


                    const builtTaxes = sourceTaxes.map(
                        (tax, taxIndex) => {

                            const source =
                                cleanText(
                                    tax.source
                                ).toUpperCase();


                            // ============================================
                            // IMPUESTO HEREDADO DEL XML
                            // ============================================

                            if (source === 'XML') {

                                const sourceTaxIndex =
                                    Number(
                                        tax.sourceTaxIndex
                                    );


                                if (
                                    !Number.isInteger(
                                        sourceTaxIndex
                                    ) ||
                                    sourceTaxIndex < 0 ||
                                    sourceTaxIndex >=
                                    originalTaxes.length
                                ) {

                                    throw new Error(
                                        `La línea ${lineIndex + 1}, impuesto ${taxIndex + 1}, ` +
                                        `no corresponde a un impuesto válido del XML.`
                                    );
                                }


                                const original =
                                    originalTaxes[
                                    sourceTaxIndex
                                    ];


                                const options =
                                    Array.isArray(
                                        original.taxOptions
                                    )
                                        ? original.taxOptions
                                        : [];


                                let selectedTaxId =
                                    cleanText(
                                        tax.taxId ||
                                        original.taxId
                                    );


                                let selectedTaxName =
                                    cleanText(
                                        tax.taxName ||
                                        original.taxName
                                    );


                                let selectedMappingId =
                                    cleanText(
                                        original.mappingId
                                    );


                                if (options.length > 1) {

                                    if (!selectedTaxId) {

                                        throw new Error(
                                            `Selecciona el código NetSuite para el impuesto ` +
                                            `${original.authorityCode || original.name || ''} ` +
                                            `de la línea ${lineIndex + 1}.`
                                        );
                                    }


                                    const selectedOption =
                                        options.find(
                                            option =>
                                                String(
                                                    option.taxId
                                                ) ===
                                                String(
                                                    selectedTaxId
                                                )
                                        );


                                    if (!selectedOption) {

                                        throw new Error(
                                            `El código de impuesto ${selectedTaxId} no pertenece ` +
                                            `a las opciones del impuesto XML ` +
                                            `${original.authorityCode || original.name || ''}.`
                                        );
                                    }


                                    selectedTaxName =
                                        selectedOption.taxName ||
                                        selectedTaxName;


                                    selectedMappingId =
                                        selectedOption.mappingId ||
                                        selectedMappingId;
                                }


                                if (
                                    !selectedTaxId &&
                                    !['EXEMPT', 'UNAFFECTED'].includes(
                                        original.type
                                    )
                                ) {

                                    throw new Error(
                                        `El impuesto XML ${original.authorityCode || original.name || ''} ` +
                                        `de la línea ${lineIndex + 1} no tiene código NetSuite configurado.`
                                    );
                                }


                                const taxableAmount =
                                    Math.abs(
                                        toNumber(
                                            tax.taxableAmount !== undefined &&
                                                tax.taxableAmount !== null &&
                                                tax.taxableAmount !== ''
                                                ? tax.taxableAmount
                                                : distributionLine.amount
                                        )
                                    );


                                const rate =
                                    toNumber(
                                        original.rate
                                    );


                                const amount =
                                    ['EXEMPT', 'UNAFFECTED'].includes(
                                        original.type
                                    )
                                        ? 0
                                        : Number(
                                            (
                                                taxableAmount *
                                                (
                                                    rate /
                                                    100
                                                )
                                            ).toFixed(2)
                                        );


                                return {
                                    type:
                                        original.type,

                                    authorityCode:
                                        original.authorityCode,

                                    name:
                                        original.name,

                                    rate,

                                    originalRate:
                                        original.originalRate,

                                    taxableAmount,

                                    amount,

                                    taxId:
                                        selectedTaxId,

                                    taxName:
                                        selectedTaxName,

                                    mappingId:
                                        selectedMappingId,

                                    source:
                                        'XML',

                                    manual:
                                        false
                                };
                            }


                            // ============================================
                            // IMPUESTO MANUAL
                            // ============================================

                            if (source === 'MANUAL') {

                                const taxId =
                                    cleanText(
                                        tax.taxId
                                    );


                                if (!taxId) {

                                    throw new Error(
                                        `La línea ${lineIndex + 1}, impuesto manual ${taxIndex + 1}, ` +
                                        `no tiene código NetSuite.`
                                    );
                                }


                                const metadata =
                                    getManualTaxMetadata(
                                        invoiceData.countryCode,
                                        taxId
                                    );


                                const taxableAmount =
                                    Math.abs(
                                        toNumber(
                                            tax.taxableAmount !== undefined &&
                                                tax.taxableAmount !== null &&
                                                tax.taxableAmount !== ''
                                                ? tax.taxableAmount
                                                : tax.base
                                        )
                                    );


                                if (taxableAmount <= 0) {

                                    throw new Error(
                                        `La línea ${lineIndex + 1}, impuesto manual ${taxIndex + 1}, ` +
                                        `debe tener una base mayor a cero.`
                                    );
                                }


                                const rate =
                                    toNumber(
                                        metadata.rate
                                    );


                                const amount =
                                    ['EXEMPT', 'UNAFFECTED'].includes(
                                        metadata.type
                                    )
                                        ? 0
                                        : Number(
                                            (
                                                taxableAmount *
                                                (
                                                    rate /
                                                    100
                                                )
                                            ).toFixed(2)
                                        );


                                return {
                                    type:
                                        metadata.type,

                                    authorityCode:
                                        metadata.authorityCode ||
                                        'MANUAL',

                                    name:
                                        metadata.name ||
                                        metadata.taxName ||
                                        'Impuesto manual',

                                    rate,

                                    originalRate:
                                        String(
                                            rate
                                        ),

                                    taxableAmount,

                                    amount,

                                    taxId:
                                        metadata.taxId,

                                    taxName:
                                        metadata.taxName,

                                    mappingId:
                                        metadata.mappingId,

                                    source:
                                        'MANUAL',

                                    manual:
                                        true
                                };
                            }


                            throw new Error(
                                `La línea ${lineIndex + 1} contiene un impuesto con origen no válido.`
                            );
                        }
                    );

                    /*
                     * NetSuite no permite repetir el mismo Tax Code dentro de
                     * Tax Details para la misma taxdetailsreference (misma línea
                     * expense). Si el usuario agrega manualmente un Tax Code que
                     * ya viene heredado del XML, conservamos el XML y omitimos el
                     * duplicado manual para no duplicar la retención/impuesto.
                     */
                    const uniqueTaxes = [];
                    const taxIndexById = new Map();

                    builtTaxes.forEach(
                        tax => {

                            const taxId =
                                cleanText(
                                    tax.taxId
                                );

                            /*
                             * EXEMPT/UNAFFECTED sin taxId se conservan porque no
                             * generan la colisión reportada por NetSuite.
                             */
                            if (!taxId) {
                                uniqueTaxes.push(tax);
                                return;
                            }

                            if (!taxIndexById.has(taxId)) {
                                taxIndexById.set(
                                    taxId,
                                    uniqueTaxes.length
                                );

                                uniqueTaxes.push(tax);
                                return;
                            }

                            const existingIndex =
                                taxIndexById.get(taxId);

                            const existing =
                                uniqueTaxes[
                                existingIndex
                                ];

                            const existingSource =
                                cleanText(
                                    existing.source
                                ).toUpperCase();

                            const incomingSource =
                                cleanText(
                                    tax.source
                                ).toUpperCase();

                            /*
                             * XML tiene prioridad sobre MANUAL. El caso que
                             * originó el USER_ERROR fue exactamente XML 1309 +
                             * MANUAL 1309 en la misma línea.
                             */
                            if (
                                existingSource === 'XML' &&
                                incomingSource === 'MANUAL'
                            ) {

                                log.audit({
                                    title:
                                        'Impuesto manual duplicado omitido',

                                    details: {
                                        lineIndex,
                                        taxId,
                                        keptSource:
                                            existingSource,
                                        omittedSource:
                                            incomingSource,
                                        taxableAmount:
                                            tax.taxableAmount,
                                        amount:
                                            tax.amount
                                    }
                                });

                                return;
                            }

                            if (
                                existingSource === 'MANUAL' &&
                                incomingSource === 'XML'
                            ) {

                                uniqueTaxes[
                                    existingIndex
                                ] = tax;

                                log.audit({
                                    title:
                                        'Impuesto XML reemplazó duplicado manual',

                                    details: {
                                        lineIndex,
                                        taxId
                                    }
                                });

                                return;
                            }

                            /*
                             * Dos XML o dos manuales con el mismo Tax Code dentro
                             * de la misma categoría son ambiguos. Frenamos antes
                             * de record.save() con un mensaje entendible.
                             */
                            throw new Error(
                                `La línea ${lineIndex + 1} contiene el Tax Code ` +
                                `${taxId} más de una vez. Cada Tax Code sólo puede ` +
                                `aparecer una vez por línea.`
                            );
                        }
                    );

                    return uniqueTaxes;
                } catch (functionError) {
                    logFunctionError('createVendorBill.buildLineTaxes', functionError);
                    throw functionError;
                }
            };


        let distributedSubtotal =
            0;


        expenseDistribution =
            expenseDistribution.map(
                (line, index) => {

                    const itemId =
                        isItemMode
                            ? cleanText(
                                line.itemId
                            )
                            : '';


                    const categoryId =
                        isItemMode
                            ? ''
                            : cleanText(
                                line.categoryId
                            );


                    const amount =
                        Math.abs(
                            toNumber(
                                line.amount
                            )
                        );


                    if (isItemMode && !itemId) {

                        throw new Error(
                            `Selecciona el artículo de la línea ${index + 1}.`
                        );
                    }


                    if (!isItemMode && !categoryId) {

                        throw new Error(
                            `Selecciona la categoría de gasto de la línea ${index + 1}.`
                        );
                    }


                    if (amount <= 0) {

                        throw new Error(
                            `La línea ${index + 1} debe tener un importe mayor a cero.`
                        );
                    }


                    distributedSubtotal +=
                        amount;


                    // Artículos y gastos usan el mismo tratamiento de impuestos.
                    const taxes =
                        buildLineTaxes(
                            {
                                ...line,
                                amount
                            },
                            index
                        );


                    return {
                        itemId,
                        categoryId,
                        appliesIgv:
                            isItemMode &&
                            line.appliesIgv === true &&
                            cleanText(invoiceData.countryCode).toUpperCase() === 'PE',
                        amount,
                        memo:
                            cleanText(
                                line.memo
                            ),
                        taxes
                    };
                }
            );


        const subtotal =
            toNumber(
                params.custpage_subtotal
            );


        distributedSubtotal =
            Number(
                distributedSubtotal.toFixed(2)
            );


        if (
            Math.abs(
                distributedSubtotal -
                subtotal
            ) > 0.01
        ) {

            throw new Error(
                `El subtotal del XML (${subtotal.toFixed(2)}) debe quedar completamente distribuido. ` +
                `Actualmente ${isItemMode ? 'los artículos' : 'las categorías'} suman ${distributedSubtotal.toFixed(2)}.`
            );
        }


        log.audit({
            title:
                'Distribución de líneas validada',

            details: {
                lineMode,

                subtotalXml:
                    subtotal,

                distributedSubtotal,

                lines:
                    expenseDistribution
            }
        });


        const total = toNumber(params.custpage_total);
        const expectedTotal = toNumber(params.custpage_total_esperado) || total;
        const dueDate = parseNetSuiteDate(params.custpage_vencimiento);

        // Para Perú y Colombia, la fecha capturada por el usuario
        // será la fecha de la factura de proveedor en NetSuite.
        const isEditableIssueDate = ['PE', 'CO'].includes(
            cleanText(invoiceData.countryCode).toUpperCase()
        );

        const selectedIssueDate = isEditableIssueDate
            ? parseNetSuiteDate(params.custpage_fecha_emision)
            : null;

        if (isEditableIssueDate && !selectedIssueDate) {
            throw new Error(
                'Selecciona una fecha de emisión válida para crear la factura.'
            );
        }

        const brandSegmentId = getBrandSegmentId(params.custpage_marca);

        // ============================================================
        // NÚMERO DE FACTURA / N° REFERENCIA
        // documentNumber = folio / cbc:ID
        // documentId     = UUID / CUFE
        // ============================================================
        const invoiceReference = cleanText(
            invoiceData.documentNumber || invoiceData.documentId
        ).toUpperCase();

        if (!invoiceReference) {
            throw new Error(
                'El XML no contiene un número de factura para asignar a N° Referencia.'
            );
        }

        const bill = record.create({
            type: record.Type.VENDOR_BILL,
            isDynamic: true
        });

        // ============================================================
        // FORMULARIO DE VENDOR BILL POR PAÍS
        // ============================================================
        const vendorBillCustomForms = {
            PE: 214,
            CO: 232
        };

        const vendorBillCustomFormId =
            vendorBillCustomForms[
            cleanText(invoiceData.countryCode).toUpperCase()
            ] || '';

        if (vendorBillCustomFormId) {
            bill.setValue({
                fieldId: 'customform',
                value: Number(vendorBillCustomFormId)
            });

            log.audit({
                title: 'Formulario Vendor Bill asignado',
                details: {
                    countryCode: invoiceData.countryCode,
                    customFormId: vendorBillCustomFormId
                }
            });
        }

        // Primero campos que pueden disparar sourcing.
        safeSetValue(bill, 'entity', vendorId);
        safeSetValue(bill, 'subsidiary', params.custpage_subsidiaria);
        safeSetValue(bill, 'currency', params.custpage_moneda);


        // ============================================================
        // CUENTA CXP DEL ENCABEZADO
        // ============================================================

        const apAccountId =
            findAccountByNumber(
                CONFIG.AP_ACCOUNT_NUMBER
            );


        if (!apAccountId) {

            throw new Error(
                `No fue posible determinar la cuenta CxP ` +
                `${CONFIG.AP_ACCOUNT_NUMBER}.`
            );
        }


        bill.setValue({
            fieldId:
                'account',

            value:
                Number(
                    apAccountId
                )
        });


        const apAccountAssigned =
            cleanText(
                bill.getValue({
                    fieldId:
                        'account'
                })
            );


        log.audit({
            title:
                'Cuenta CxP asignada a Vendor Bill',

            details: {
                accountNumber:
                    CONFIG.AP_ACCOUNT_NUMBER,

                accountId:
                    apAccountId,

                assignedValue:
                    apAccountAssigned
            }
        });


        if (
            String(
                apAccountAssigned
            ) !==
            String(
                apAccountId
            )
        ) {

            throw new Error(
                `NetSuite no conservó la cuenta CxP ` +
                `${CONFIG.AP_ACCOUNT_NUMBER} en la factura.`
            );
        }


        // Perú y Colombia: usar la fecha editable como fecha de transacción.
        // México conserva el comportamiento actual.
        if (isEditableIssueDate) {
            bill.setValue({
                fieldId: 'trandate',
                value: selectedIssueDate
            });
        }

        // ============================================================
        // N° REFERENCIA: número real de la factura
        // ============================================================
        try {
            bill.setValue({
                fieldId: 'tranid',
                value: invoiceReference
            });

            const tranidBeforeSave = cleanText(
                bill.getValue({ fieldId: 'tranid' })
            );

            log.audit({
                title: 'N° Referencia asignado',
                details: {
                    country: invoiceData.countryCode,
                    documentNumber: invoiceData.documentNumber,
                    documentId: invoiceData.documentId,
                    valueRequested: invoiceReference,
                    tranidBeforeSave
                }
            });

            if (tranidBeforeSave !== invoiceReference) {
                throw new Error(
                    `NetSuite no conservó el número de referencia ${invoiceReference} antes de guardar.`
                );
            }
        } catch (error) {
            log.error({
                title: 'Error asignando N° Referencia',
                details: {
                    country: invoiceData.countryCode,
                    documentNumber: invoiceData.documentNumber,
                    documentId: invoiceData.documentId,
                    invoiceReference,
                    message: error.message
                }
            });

            throw new Error(
                `No fue posible asignar el número de factura ${invoiceReference} ` +
                `al campo N° Referencia: ${error.message}`
            );
        }

        safeSetValue(bill, 'duedate', dueDate);
        safeSetValue(bill, 'department', params.custpage_departamento);
        safeSetValue(bill, 'memo', params.custpage_descripcion);

        safeSetValue(bill, CONFIG.FIELDS.REGIONAL_HEADER, params.custpage_ubicacion);
        safeSetValue(bill, CONFIG.FIELDS.BRAND_HEADER, params.custpage_marca);
        safeSetValue(bill, CONFIG.FIELDS.BRAND_SEGMENT_HEADER, brandSegmentId);
        safeSetValue(bill, CONFIG.FIELDS.JUSTIFICATION_HEADER, params.custpage_justificacion);
        safeSetValue(bill, CONFIG.FIELDS.DESCRIPTION_HEADER, params.custpage_descripcion);
        safeSetValue(bill, CONFIG.FIELDS.PLATE_HEADER, params.custpage_placas);
        safeSetValue(bill, CONFIG.FIELDS.CREATED_BY_PLANNER, true);
        safeSetValue(bill, CONFIG.FIELDS.XML_FILE, Number(params.custpage_xml_id));
        safeSetValue(bill, CONFIG.FIELDS.PDF_FILE, Number(params.custpage_pdf_id));

        // Identificador fiscal único: UUID / CUFE / equivalente.
        safeSetValue(
            bill,
            countryConfig.transactionTaxIdField,
            invoiceData.documentId
        );

        // ============================================================
        // CREAR UNA LÍNEA POR FILA: ITEM (ARTÍCULOS) O EXPENSE (GASTOS)
        // ============================================================

        // Moneda efectiva de la factura: del formulario o de la fuente del
        // proveedor cuando este se acaba de crear y el campo llega vacío.
        const billCurrencyId =
            bill.getValue({
                fieldId:
                    'currency'
            });


        /*
         * Los rangos de la parametrización de artículos hijo están siempre en
         * la moneda base (Soles), así que el total se convierte con el tipo de
         * cambio de la factura, ya calculado por NetSuite para su fecha.
         * En una factura en Soles el tipo de cambio es 1.
         */
        const exchangeRate =
            toNumber(
                bill.getValue({
                    fieldId:
                        'exchangerate'
                })
            );


        const totalInBaseCurrency =
            exchangeRate > 0
                ? Number(
                    (
                        total *
                        exchangeRate
                    ).toFixed(2)
                )
                : null;


        log.audit({
            title:
                'Total para parametrización de artículos hijo',

            details: {
                total,
                billCurrencyId,
                exchangeRate,
                totalInBaseCurrency
            }
        });


        /*
         * Línea de artículo: campos propios del artículo, clasificaciones
         * contables e impuestos del planificador (mismos campos que gastos).
         * La cuenta contable la determina el artículo.
         */
        const addItemLine = (distributionLine, lineIndex) => {
            try {

                const lineTaxes =
                    Array.isArray(distributionLine.taxes)
                        ? distributionLine.taxes
                        : [];


                const lineMainTax =
                    lineTaxes.find(
                        tax =>
                            ['TRANSFER', 'EXEMPT', 'UNAFFECTED'].includes(tax.type) &&
                            tax.taxId
                    );


                const sumTaxes = types => {
                    try {
                        return lineTaxes
                            .filter(tax => types.includes(tax.type))
                            .reduce((sum, tax) => sum + toNumber(tax.amount), 0);
                    } catch (functionError) {
                        logFunctionError('createVendorBill.addItemLine.sumTaxes', functionError);
                        throw functionError;
                    }
                };


                const lineExpectedTotal =
                    Number(
                        (
                            distributionLine.amount +
                            sumTaxes(['TRANSFER']) -
                            sumTaxes(['WITHHOLDING', 'DETRACTION'])
                        ).toFixed(2)
                    );



                const childItemId =
                    distributionLine.appliesIgv
                        ? findChildItemId({
                            parentItemId:
                                distributionLine.itemId,

                            currencyId:
                                billCurrencyId,

                            totalInBaseCurrency
                        })
                        : '';


                const billItemId =
                    childItemId ||
                    distributionLine.itemId;


                bill.selectNewLine({
                    sublistId:
                        'item'
                });


                // El artículo primero: su sourcing rellena tarifa y descripción.
                safeSetCurrentValue(bill, 'item', 'item', billItemId);
                safeSetCurrentValue(bill, 'item', 'quantity', 1);
                safeSetCurrentValue(bill, 'item', 'rate', distributionLine.amount);
                safeSetCurrentValue(bill, 'item', 'amount', distributionLine.amount);

                safeSetCurrentValue(
                    bill,
                    'item',
                    'description',
                    distributionLine.memo ||
                    params.custpage_justificacion
                );

                safeSetCurrentValue(bill, 'item', 'department', params.custpage_departamento);
                safeSetCurrentValue(bill, 'item', 'location', params.custpage_ubicacion);
                safeSetCurrentValue(bill, 'item', CONFIG.FIELDS.BRAND_SEGMENT_LINE, brandSegmentId);


                // Impuestos: mismos campos de línea que el proceso de gastos.
                if (lineMainTax) {
                    safeSetCurrentValue(bill, 'item', CONFIG.FIELDS.TAX_LINE, lineMainTax.taxId);
                }

                safeSetCurrentValue(bill, 'item', CONFIG.FIELDS.EXPECTED_TOTAL_LINE, lineExpectedTotal);

                safeSetCurrentValue(
                    bill,
                    'item',
                    'custcol_cs_tax_details_json',
                    JSON.stringify(
                        lineTaxes.map(
                            tax => ({
                                taxId: tax.taxId,
                                type: tax.type,
                                rate: tax.rate,
                                amount: tax.amount,
                                taxableAmount: tax.taxableAmount,
                                manual: Boolean(tax.manual)
                            })
                        )
                    )
                );


                log.audit({
                    title:
                        `Línea item ${lineIndex + 1} preparada`,

                    details: {
                        itemId:
                            distributionLine.itemId,

                        appliesIgv:
                            distributionLine.appliesIgv,

                        billItemId,

                        amount:
                            distributionLine.amount,

                        lineExpectedTotal,

                        taxes:
                            lineTaxes
                    }
                });


                bill.commitLine({
                    sublistId:
                        'item'
                });
            } catch (functionError) {
                logFunctionError('createVendorBill.addItemLine', functionError);
                throw functionError;
            }
        };


        expenseDistribution.forEach(
            (distributionLine, lineIndex) => {

                if (isItemMode) {

                    addItemLine(
                        distributionLine,
                        lineIndex
                    );

                    return;
                }


                const lineTaxes =
                    Array.isArray(
                        distributionLine.taxes
                    )
                        ? distributionLine.taxes
                        : [];


                const lineMainTax =
                    lineTaxes.find(
                        item =>
                            [
                                'TRANSFER',
                                'EXEMPT',
                                'UNAFFECTED'
                            ].includes(
                                item.type
                            ) &&
                            item.taxId
                    );


                const lineTransferTotal =
                    lineTaxes
                        .filter(
                            tax =>
                                tax.type ===
                                'TRANSFER'
                        )
                        .reduce(
                            (sum, tax) =>
                                sum +
                                toNumber(
                                    tax.amount
                                ),
                            0
                        );


                const lineWithholdingTotal =
                    lineTaxes
                        .filter(
                            tax =>
                                [
                                    'WITHHOLDING',
                                    'DETRACTION'
                                ].includes(
                                    tax.type
                                )
                        )
                        .reduce(
                            (sum, tax) =>
                                sum +
                                toNumber(
                                    tax.amount
                                ),
                            0
                        );


                const lineExpectedTotal =
                    Number(
                        (
                            distributionLine.amount +
                            lineTransferTotal -
                            lineWithholdingTotal
                        ).toFixed(2)
                    );


                bill.selectNewLine({
                    sublistId:
                        'expense'
                });


                safeSetCurrentValue(
                    bill,
                    'expense',
                    'category',
                    distributionLine.categoryId
                );


                const category =
                    record.load({
                        type:
                            'expensecategory',

                        id:
                            distributionLine.categoryId
                    });


                const accountId =
                    category.getValue(
                        CONFIG.FIELDS.EXPENSE_CATEGORY_ACCOUNT
                    );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    'account',
                    accountId
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    'amount',
                    distributionLine.amount
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    'department',
                    params.custpage_departamento
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    'memo',
                    distributionLine.memo ||
                    params.custpage_justificacion
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    CONFIG.FIELDS.REGIONAL_LINE,
                    params.custpage_ubicacion
                );


                try {

                    bill.setCurrentSublistValue({
                        sublistId:
                            'expense',

                        fieldId:
                            'location',

                        value:
                            params.custpage_ubicacion,

                        forceSyncSourcing:
                            true
                    });


                    const appliedLocation =
                        bill.getCurrentSublistValue({
                            sublistId:
                                'expense',

                            fieldId:
                                'location'
                        });


                    if (
                        String(
                            appliedLocation ||
                            ''
                        ) !==
                        String(
                            params.custpage_ubicacion ||
                            ''
                        )
                    ) {

                        bill.setCurrentSublistValue({
                            sublistId:
                                'expense',

                            fieldId:
                                'location',

                            value:
                                ''
                        });
                    }

                } catch (locationError) {

                    log.debug({
                        title:
                            'Location nativo no disponible en línea',

                        details: {
                            lineIndex,
                            message:
                                locationError.message
                        }
                    });
                }


                safeSetCurrentValue(
                    bill,
                    'expense',
                    CONFIG.FIELDS.BRAND_LINE,
                    params.custpage_marca
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    CONFIG.FIELDS.BRAND_SEGMENT_LINE,
                    brandSegmentId
                );


                if (lineMainTax) {

                    safeSetCurrentValue(
                        bill,
                        'expense',
                        CONFIG.FIELDS.TAX_LINE,
                        lineMainTax.taxId
                    );
                }


                safeSetCurrentValue(
                    bill,
                    'expense',
                    CONFIG.FIELDS.VENDOR_LINE,
                    vendorId
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    CONFIG.FIELDS.EXPECTED_TOTAL_LINE,
                    lineExpectedTotal
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    CONFIG.FIELDS.GD_NAME_LINE,
                    Number(
                        vendorId
                    )
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    CONFIG.FIELDS.DUE_DATE_LINE,
                    dueDate
                );


                safeSetCurrentValue(
                    bill,
                    'expense',
                    'custcol_cs_tax_details_json',
                    JSON.stringify(
                        lineTaxes.map(
                            tax => ({
                                taxId:
                                    tax.taxId,

                                type:
                                    tax.type,

                                rate:
                                    tax.rate,

                                amount:
                                    tax.amount,

                                taxableAmount:
                                    tax.taxableAmount,

                                manual:
                                    Boolean(
                                        tax.manual
                                    )
                            })
                        )
                    )
                );


                log.audit({
                    title:
                        `Línea expense ${lineIndex + 1} preparada`,

                    details: {
                        categoryId:
                            distributionLine.categoryId,

                        amount:
                            distributionLine.amount,

                        accountId,

                        lineExpectedTotal,

                        taxes:
                            lineTaxes
                    }
                });


                bill.commitLine({
                    sublistId:
                        'expense'
                });
            }
        );


        const billId = bill.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });

        // ============================================================
        // VERIFICAR LO GUARDADO EN NETSUITE
        // ============================================================
        const created = record.load({
            type: record.Type.VENDOR_BILL,
            id: billId,
            isDynamic: false
        });

        const savedReference = cleanText(
            created.getValue({ fieldId: 'tranid' })
        );

        const transactionNumber = cleanText(
            created.getValue({ fieldId: 'transactionnumber' })
        );

        const savedFiscalId = cleanText(
            created.getValue({ fieldId: countryConfig.transactionTaxIdField })
        );

        log.audit({
            title: 'Vendor Bill guardada',
            details: {
                billId,
                country: invoiceData.countryCode,
                documentNumber: invoiceData.documentNumber,
                documentId: invoiceData.documentId,
                expectedReference: invoiceReference,
                savedReference,
                transactionNumber,
                savedFiscalId
            }
        });

        if (!savedReference) {
            throw new Error(
                `La factura ${billId} fue creada, pero NetSuite dejó vacío el campo ` +
                `N° Referencia. El valor enviado fue ${invoiceReference}.`
            );
        }

        if (savedReference !== invoiceReference) {
            log.error({
                title: 'N° Referencia modificada por NetSuite',
                details: {
                    expected: invoiceReference,
                    saved: savedReference,
                    transactionNumber
                }
            });
        }

        return {
            billId,
            transactionNumber: transactionNumber || savedReference,
            referenceNumber: savedReference,
            documentId: invoiceData.documentId
        };
    };

    // -------------------------------------------------------------------------
    // Interfaz HTML pura
    // -------------------------------------------------------------------------

    const getPlannerHomeUrl = () => {
        try {
            return url.resolveScript({
                scriptId: 'customscript_cs_sl_planificador_co_pe',
                deploymentId: 'customdeploy_cs_sl_planificador_co_pe',
                returnExternalUrl: false
            });
        } catch (functionError) {
            logFunctionError('getPlannerHomeUrl', functionError);
            throw functionError;
        }
    };

    const writeHtml = (context, html) => {
        try {
            context.response.setHeader({
                name: 'Content-Type',
                value: 'text/html; charset=UTF-8'
            });
            context.response.write({ output: html });
        } catch (functionError) {
            logFunctionError('writeHtml', functionError);
            throw functionError;
        }
    };

    const formatHtmlDate = value => {
        try {

            const normalized =
                normalizeIssueDate(value);

            if (normalized) {
                return normalized;
            }


            const date =
                value instanceof Date
                    ? value
                    : new Date(value);


            if (
                !date ||
                Number.isNaN(
                    date.getTime()
                )
            ) {
                return '';
            }


            const year =
                date.getFullYear();

            const month =
                String(
                    date.getMonth() + 1
                ).padStart(2, '0');

            const day =
                String(
                    date.getDate()
                ).padStart(2, '0');


            return (
                `${year}-` +
                `${month}-` +
                `${day}`
            );
        } catch (functionError) {
            logFunctionError('formatHtmlDate', functionError);
            throw functionError;
        }
    };

    const getSearchOptions = (searchObject, valueGetter, textGetter) => {
        try {
            const options = [];

            searchObject.run().each(result => {
                const value = valueGetter(result);
                const text = textGetter(result);

                if (value !== null && value !== undefined && value !== '') {
                    options.push({
                        value: String(value),
                        text: cleanText(text) || String(value)
                    });
                }

                return true;
            });

            return options;
        } catch (functionError) {
            logFunctionError('getSearchOptions', functionError);
            throw functionError;
        }
    };

    const renderOptions = (
        options,
        selectedValue = '',
        placeholder = 'Selecciona una opción'
    ) => {
        try {
            const selected = String(selectedValue || '');

            return [
                `<option value="">${escapeHtml(placeholder)}</option>`,
                ...(options || []).map(item => {
                    const value = String(item.value || '');
                    const isSelected = value === selected ? ' selected' : '';

                    return `<option value="${escapeHtml(value)}"${isSelected}>${escapeHtml(item.text || value)}</option>`;
                })
            ].join('');
        } catch (functionError) {
            logFunctionError('renderOptions', functionError);
            throw functionError;
        }
    };

    const renderMultiOptions = (options, selectedValues = []) => {
        try {
            const selectedSet = new Set(
                (selectedValues || []).map(value => String(value))
            );

            return (options || []).map(item => {
                const value = String(item.value || '');
                const isSelected = selectedSet.has(value) ? ' selected' : '';
                return `<option value="${escapeHtml(value)}"${isSelected}>${escapeHtml(item.text || value)}</option>`;
            }).join('');
        } catch (functionError) {
            logFunctionError('renderMultiOptions', functionError);
            throw functionError;
        }
    };

    const getExpenseCategoryOptions = subsidiaryIds => {
        try {
            return getSearchOptions(
                search.create({
                    type: 'expensecategory',
                    filters: [
                        [CONFIG.FIELDS.EXPENSE_CATEGORY_AVAILABLE, 'is', 'F'],
                        'AND',
                        ['isinactive', 'is', 'F'],
                        'AND',
                        ['subsidiary', 'anyof', subsidiaryIds]
                    ],
                    columns: [
                        search.createColumn({
                            name: 'internalid',
                            summary: search.Summary.GROUP
                        }),
                        search.createColumn({
                            name: 'name',
                            summary: search.Summary.GROUP,
                            sort: search.Sort.ASC
                        })
                    ]
                }),
                result => result.getValue({
                    name: 'internalid',
                    summary: search.Summary.GROUP
                }),
                result => result.getValue({
                    name: 'name',
                    summary: search.Summary.GROUP
                })
            );
        } catch (functionError) {
            logFunctionError('getExpenseCategoryOptions', functionError);
            throw functionError;
        }
    };

    /*
     * Artículos marcados para mostrarse en el planificador, limitados a las
     * subsidiarias indicadas. Se agrupa porque un artículo asignado a varias
     * subsidiarias devuelve una fila por cada una.
     */
    const getPlannerItemOptions = subsidiaryIds => {
        try {
            return getSearchOptions(
                search.create({
                    type: search.Type.ITEM,
                    filters: [
                        [CONFIG.FIELDS.ITEM_SHOW_IN_PLANNER, 'is', 'T'],
                        'AND',
                        ['isinactive', 'is', 'F'],
                        'AND',
                        ['subsidiary', 'anyof', subsidiaryIds]
                    ],
                    columns: [
                        search.createColumn({
                            name: 'internalid',
                            summary: search.Summary.GROUP
                        }),
                        search.createColumn({
                            name: 'itemid',
                            summary: search.Summary.GROUP,
                            sort: search.Sort.ASC
                        })
                    ]
                }),
                result => result.getValue({
                    name: 'internalid',
                    summary: search.Summary.GROUP
                }),
                result => result.getValue({
                    name: 'itemid',
                    summary: search.Summary.GROUP
                })
            );
        } catch (functionError) {
            logFunctionError('getPlannerItemOptions', functionError);
            throw functionError;
        }
    };

    /*
     * Artículo hijo parametrizado para un artículo padre, según la moneda de
     * la factura y su total convertido a Soles, porque los rangos de la
     * parametrización siempre están en Soles (límites incluidos). Si hay más
     * de una coincidencia se toma el registro con el internalid más alto.
     * Devuelve vacío si no hay parametrización que aplique.
     */
    const findChildItemId = ({ parentItemId, currencyId, totalInBaseCurrency }) => {
        try {
            const params = CONFIG.ITEM_PARAMETERS;

            if (!currencyId || totalInBaseCurrency === null) {
                return '';
            }

            const results = search.create({
                type: params.RECORD,
                filters: [
                    ['isinactive', 'is', 'F'],
                    'AND',
                    [params.PARENT_ITEM, 'anyof', parentItemId],
                    'AND',
                    [params.CURRENCY, 'anyof', currencyId],
                    'AND',
                    [params.CHILD_ITEM, 'noneof', '@NONE@'],
                    'AND',
                    [params.MIN_AMOUNT, 'lessthanorequalto', totalInBaseCurrency],
                    'AND',
                    [params.MAX_AMOUNT, 'greaterthanorequalto', totalInBaseCurrency]
                ],
                columns: [
                    search.createColumn({
                        name: 'internalid',
                        sort: search.Sort.DESC
                    }),
                    search.createColumn({ name: params.CHILD_ITEM })
                ]
            }).run().getRange({ start: 0, end: 1 });

            log.audit({
                title: 'Búsqueda de artículo hijo',
                details: {
                    parentItemId,
                    currencyId,
                    totalInBaseCurrency,
                    foundChildItemId: results.length
                        ? results[0].getValue(params.CHILD_ITEM)
                        : null
                }
            });

            return results.length
                ? cleanText(results[0].getValue(params.CHILD_ITEM))
                : '';
        } catch (functionError) {
            logFunctionError('findChildItemId', functionError);
            throw functionError;
        }
    };

    const getLocationOptions = subsidiaryIds => {
        try {
            return getSearchOptions(
                search.create({
                    type: search.Type.LOCATION,
                    filters: [
                        ['subsidiary', 'anyof', subsidiaryIds],
                        'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: [
                        search.createColumn({
                            name: 'name',
                            sort: search.Sort.ASC
                        })
                    ]
                }),
                result => result.id,
                result => result.getValue('name')
            );
        } catch (functionError) {
            logFunctionError('getLocationOptions', functionError);
            throw functionError;
        }
    };

    const getSimpleRecordOptions = (type, filters = []) => {
        try {
            return getSearchOptions(
                search.create({
                    type,
                    filters: filters.length
                        ? filters
                        : [['isinactive', 'is', 'F']],
                    columns: [
                        search.createColumn({ name: 'internalid' }),
                        search.createColumn({ name: 'name', sort: search.Sort.ASC })
                    ]
                }),
                result => result.getValue('internalid'),
                result => result.getValue('name')
            );
        } catch (error) {
            log.error({
                title: `Error cargando opciones ${type}`,
                details: error
            });
            return [];
        }
    };

    const getBankOptions = countryCode => {

        const normalizedCountry =
            cleanText(countryCode).toUpperCase();

        const countryConfig =
            CONFIG.COUNTRY[normalizedCountry];

        const bankCountryId =
            countryConfig?.bankCountryId || '';

        if (!bankCountryId) {

            log.error({
                title: 'País bancario no configurado',
                details: {
                    countryCode: normalizedCountry
                }
            });

            return [];
        }

        try {

            const bankSearch = search.create({
                type: 'customrecord_ce_catalogo_bancos',
                filters: [
                    [
                        'custrecord52',
                        'anyof',
                        String(bankCountryId)
                    ],
                    'AND',
                    [
                        'isinactive',
                        'is',
                        'F'
                    ]
                ],
                columns: [
                    search.createColumn({
                        name: 'internalid'
                    }),
                    search.createColumn({
                        name: 'name',
                        sort: search.Sort.ASC
                    }),
                    search.createColumn({
                        name: 'custrecord52'
                    })
                ]
            });

            const options =
                getSearchOptions(
                    bankSearch,
                    result =>
                        result.getValue({
                            name: 'internalid'
                        }),
                    result =>
                        result.getValue({
                            name: 'name'
                        })
                );

            log.audit({
                title: 'Bancos filtrados por país',
                details: {
                    countryCode: normalizedCountry,
                    bankCountryId,
                    bankCount: options.length
                }
            });

            return options;

        } catch (error) {

            log.error({
                title: 'Error cargando bancos por país',
                details: {
                    countryCode: normalizedCountry,
                    bankCountryId,
                    message: error.message
                }
            });

            return [];
        }
    };

    const getDepartmentOptions = () => {
        try {
            return getSearchOptions(
                search.create({
                    type: search.Type.DEPARTMENT,
                    filters: [['isinactive', 'is', 'F']],
                    columns: [
                        search.createColumn({
                            name: 'name',
                            sort: search.Sort.ASC
                        })
                    ]
                }),
                result => result.id,
                result => result.getValue('name')
            );
        } catch (functionError) {
            logFunctionError('getDepartmentOptions', functionError);
            throw functionError;
        }
    };

    const getTaxItemOptions = () => {
        try {
            return getSearchOptions(
                search.create({
                    type: 'salestaxitem',
                    filters: [['isinactive', 'is', 'F']],
                    columns: [
                        search.createColumn({ name: 'internalid' }),
                        search.createColumn({ name: 'itemid', sort: search.Sort.ASC })
                    ]
                }),
                result => result.getValue('internalid'),
                result => result.getValue('itemid')
            );
        } catch (error) {
            log.error({
                title: 'Error cargando códigos de impuesto',
                details: error
            });
            return [];
        }
    };


    const getTaxItemOptionsByCountry = countryCode => {

        const normalizedCountry =
            cleanText(countryCode).toUpperCase();

        const countryConfig =
            CONFIG.COUNTRY[normalizedCountry];

        if (!countryConfig) {
            return [];
        }

        const expectedCountryName =
            cleanText(countryConfig.name);

        const normalizeText = value => {
            try {
                return cleanText(value)
                    .toUpperCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '');
            } catch (functionError) {
                logFunctionError('getTaxItemOptionsByCountry.normalizeText', functionError);
                throw functionError;
            }
        };

        const expectedCountry =
            normalizeText(expectedCountryName);

        const options = [];
        const usedTaxIds = new Set();

        try {

            const mappingSearch =
                search.create({
                    type: CONFIG.TAX_MAPPING.RECORD,
                    filters: [
                        ['isinactive', 'is', 'F'],
                        'AND',
                        [
                            CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE,
                            'noneof',
                            '@NONE@'
                        ]
                    ],
                    columns: [
                        CONFIG.TAX_MAPPING.COUNTRY,
                        CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE,
                        CONFIG.TAX_MAPPING.XML_CODE,
                        CONFIG.TAX_MAPPING.BEHAVIOR,
                        CONFIG.TAX_MAPPING.RATE
                    ]
                });

            mappingSearch.run().each(result => {

                const countryText =
                    result.getText({
                        name: CONFIG.TAX_MAPPING.COUNTRY
                    }) || '';

                if (
                    normalizeText(countryText) !==
                    expectedCountry
                ) {
                    return true;
                }

                const taxId =
                    result.getValue({
                        name: CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE
                    }) || '';

                const taxText =
                    result.getText({
                        name: CONFIG.TAX_MAPPING.NETSUITE_TAX_CODE
                    }) || '';

                if (
                    !taxId ||
                    usedTaxIds.has(String(taxId))
                ) {
                    return true;
                }

                usedTaxIds.add(String(taxId));

                const xmlCode =
                    result.getValue({
                        name: CONFIG.TAX_MAPPING.XML_CODE
                    }) || '';

                const behaviorText =
                    result.getText({
                        name: CONFIG.TAX_MAPPING.BEHAVIOR
                    }) || '';

                const rate =
                    normalizeTaxRate(
                        result.getValue({
                            name: CONFIG.TAX_MAPPING.RATE
                        }),
                        normalizedCountry
                    );

                const suffix = [
                    xmlCode ? `Código ${xmlCode}` : '',
                    behaviorText,
                    rate ? `${rate}%` : ''
                ]
                    .filter(Boolean)
                    .join(' · ');

                options.push({
                    value: String(taxId),
                    text:
                        taxText
                            ? (
                                suffix
                                    ? `${taxText} — ${suffix}`
                                    : taxText
                            )
                            : (
                                suffix
                                    ? `Tax Code ${taxId} — ${suffix}`
                                    : `Tax Code ${taxId}`
                            ),
                    rate,
                    xmlCode,
                    behavior: behaviorText
                });

                return true;
            });

            options.sort(
                (a, b) =>
                    String(a.text).localeCompare(
                        String(b.text),
                        'es'
                    )
            );

            log.audit({
                title: 'Códigos de impuesto manuales filtrados por país',
                details: {
                    countryCode: normalizedCountry,
                    countryName: expectedCountryName,
                    count: options.length,
                    taxIds: options.map(item => item.value)
                }
            });

            return options;

        } catch (error) {

            log.error({
                title: 'Error cargando códigos de impuesto por país',
                details: {
                    countryCode: normalizedCountry,
                    countryName: expectedCountryName,
                    message: error.message,
                    stack: error.stack
                }
            });

            return [];
        }
    };


    const getCountryFlagSvg = countryCode => {
        try {
            const code = cleanText(countryCode).toUpperCase();

            if (code === 'MX') {
                return `
                <svg class="flag-svg" viewBox="0 0 60 40" role="img" aria-label="Bandera de México">
                    <rect width="20" height="40" x="0" fill="#006847"></rect>
                    <rect width="20" height="40" x="20" fill="#ffffff"></rect>
                    <rect width="20" height="40" x="40" fill="#ce1126"></rect>
                    <circle cx="30" cy="20" r="4.2" fill="#a67c52"></circle>
                    <path d="M26.7 21.3c2.2 2.9 4.4 2.9 6.6 0" fill="none" stroke="#1f7a45" stroke-width="1.4" stroke-linecap="round"></path>
                </svg>
            `;
            }

            if (code === 'PE') {
                return `
                <svg class="flag-svg" viewBox="0 0 60 40" role="img" aria-label="Bandera de Perú">
                    <rect width="20" height="40" x="0" fill="#d91023"></rect>
                    <rect width="20" height="40" x="20" fill="#ffffff"></rect>
                    <rect width="20" height="40" x="40" fill="#d91023"></rect>
                </svg>
            `;
            }

            if (code === 'CO') {
                return `
                <svg class="flag-svg" viewBox="0 0 60 40" role="img" aria-label="Bandera de Colombia">
                    <rect width="60" height="20" y="0" fill="#fcd116"></rect>
                    <rect width="60" height="10" y="20" fill="#003893"></rect>
                    <rect width="60" height="10" y="30" fill="#ce1126"></rect>
                </svg>
            `;
            }

            return '<div class="flag-placeholder">FE</div>';
        } catch (functionError) {
            logFunctionError('getCountryFlagSvg', functionError);
            throw functionError;
        }
    };

    const getCountryCssClass = countryCode => {
        try {
            const code = cleanText(countryCode).toUpperCase();
            if (code === 'MX') return 'country-mx';
            if (code === 'PE') return 'country-pe';
            if (code === 'CO') return 'country-co';
            return '';
        } catch (functionError) {
            logFunctionError('getCountryCssClass', functionError);
            throw functionError;
        }
    };

    const getBaseStyles = () => {
        try {
            return `
        <style>
            :root {
                --bg: #eaf0f6;
                --bg-deep: #dfe8f2;
                --surface: #ffffff;
                --surface-soft: #f6f9fc;
                --surface-blue: #edf5ff;
                --text: #10233e;
                --muted: #66758a;
                --border: #d8e1eb;
                --border-strong: #c4cfdb;
                --primary: #1463ff;
                --primary-2: #0a4dcc;
                --primary-soft: #e8f1ff;
                --cyan: #12b8c8;
                --navy: #081b31;
                --navy-2: #10385f;
                --success: #087443;
                --success-soft: #e8f8ef;
                --warning: #a85b00;
                --warning-soft: #fff4df;
                --danger: #b42318;
                --danger-soft: #fff0ef;
                --shadow-sm: 0 2px 8px rgba(15, 39, 70, .06);
                --shadow-md: 0 18px 44px rgba(15, 39, 70, .12);
                --shadow-blue: 0 15px 34px rgba(20, 99, 255, .17);
                --radius: 18px;
                --country-accent: #1463ff;
                --country-soft: #e8f1ff;
                --country-ink: #0a4dcc;
            }

            * { box-sizing: border-box; }

            html, body {
                margin: 0;
                min-height: 100%;
                color: var(--text);
                font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                -webkit-font-smoothing: antialiased;
                background: var(--bg);
            }

            body { min-width: 320px; }

            .app-shell {
                min-height: 100vh;
                background:
                    radial-gradient(circle at 92% 10%, rgba(20, 99, 255, .15), transparent 24%),
                    radial-gradient(circle at 10% 90%, rgba(18, 184, 200, .10), transparent 26%),
                    linear-gradient(180deg, #eef4fa 0%, #e8eef5 48%, #e2eaf3 100%);
            }

            .country-mx { --country-accent: #0b8f5a; --country-soft: #e7f8ef; --country-ink: #066a42; }
            .country-pe { --country-accent: #d71e35; --country-soft: #fff0f2; --country-ink: #a20f23; }
            .country-co { --country-accent: #f2c318; --country-soft: #fff8d9; --country-ink: #254f9d; }

            .topbar {
                min-height: 74px;
                background: linear-gradient(90deg, #07192d 0%, #0d2b4b 52%, #123e68 100%);
                color: #fff;
                border-bottom: 1px solid rgba(255,255,255,.08);
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 34px;
                position: sticky;
                top: 0;
                z-index: 30;
                box-shadow: 0 8px 28px rgba(4, 20, 39, .16);
            }

            .brand { display:flex; align-items:center; gap:13px; min-width:0; }
            .brand-mark {
                width: 42px;
                height: 42px;
                border-radius: 12px;
                background: linear-gradient(145deg, #1b76ff, #0a4dcc);
                color: #fff;
                display:grid;
                place-items:center;
                font-size: 15px;
                font-weight: 900;
                letter-spacing: -.02em;
                box-shadow: 0 8px 20px rgba(20, 99, 255, .38), inset 0 1px 0 rgba(255,255,255,.25);
            }
            .brand-title { font-size:15px; line-height:1.2; font-weight:800; color:#fff; }
            .brand-subtitle { margin-top:3px; font-size:11.5px; color:#b8c8da; }

            .top-status {
                display:inline-flex;
                align-items:center;
                gap:8px;
                padding:7px 11px;
                border:1px solid rgba(255,255,255,.12);
                background:rgba(255,255,255,.07);
                border-radius:999px;
                font-size:11.5px;
                color:#d9e6f3;
                font-weight:700;
            }
                .file-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition:
        color .18s ease,
        font-weight .18s ease;
}

/* Sin archivo */
.file-name.empty {
    color: #d92d20;
    font-weight: 800;
}

/* Pequeño indicador rojo */
.file-name.empty::before {
    content: '';
    width: 7px;
    height: 7px;
    flex: 0 0 7px;
    border-radius: 50%;
    background: #d92d20;
    box-shadow:
        0 0 0 3px rgba(217, 45, 32, .10);
}

/* Archivo seleccionado */
.file-name.selected {
    color: #067647;
    font-weight: 750;
}

/* Indicador verde */
.file-name.selected::before {
    content: '';
    width: 7px;
    height: 7px;
    flex: 0 0 7px;
    border-radius: 50%;
    background: #12b76a;
    box-shadow:
        0 0 0 3px rgba(18, 183, 106, .10);
}
            .top-status::before {
                content:'';
                width:8px; height:8px; border-radius:50%;
                background:#2fd183;
                box-shadow:0 0 0 4px rgba(47,209,131,.12);
            }

            .page {
                width: min(1320px, calc(100% - 42px));
                margin: 0 auto;
                padding: 28px 0 56px;
            }
            .page--narrow { width: min(1120px, calc(100% - 42px)); }

            .hero {
                position: relative;
                overflow: hidden;
                min-height: 184px;
                padding: 28px 30px;
                border-radius: 24px;
                background:
                    linear-gradient(135deg, rgba(8,27,49,.98), rgba(16,56,95,.98) 55%, rgba(20,99,255,.96));
                color:#fff;
                box-shadow: var(--shadow-md);
                border: 1px solid rgba(255,255,255,.08);
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:24px;
            }
            .hero::before,
            .hero::after {
                content:'';
                position:absolute;
                border-radius:50%;
                border:28px solid rgba(255,255,255,.06);
                pointer-events:none;
            }
            .hero::before { width:220px; height:220px; right:-90px; top:-105px; }
            .hero::after { width:150px; height:150px; right:115px; bottom:-105px; border-width:22px; }
            .hero-copy { position:relative; z-index:2; max-width:800px; }
            .hero-kicker {
                display:inline-flex;
                align-items:center;
                gap:8px;
                padding:7px 11px;
                border:1px solid rgba(255,255,255,.18);
                background:rgba(255,255,255,.09);
                border-radius:999px;
                color:#dceafb;
                font-size:10.5px;
                font-weight:850;
                letter-spacing:.07em;
                text-transform:uppercase;
            }
            .hero h1 {
                margin:13px 0 0;
                color:#fff;
                font-size:clamp(26px, 3vw, 38px);
                line-height:1.08;
                letter-spacing:-.038em;
            }
            .hero .lead {
                margin:11px 0 0;
                max-width:760px;
                color:#c9dbed;
                font-size:13.5px;
                line-height:1.65;
            }

            .hero-country {
                position:relative;
                z-index:2;
                min-width:220px;
                padding:16px 18px;
                border-radius:18px;
                background:rgba(255,255,255,.10);
                border:1px solid rgba(255,255,255,.15);
                backdrop-filter:blur(8px);
            }
            .hero-country-top { display:flex; align-items:center; gap:12px; }
            .hero-country-name { font-weight:850; font-size:16px; color:#fff; }
            .hero-country-caption { margin-top:2px; color:#bdd0e2; font-size:11px; }
            .hero-country-total { margin-top:14px; padding-top:12px; border-top:1px solid rgba(255,255,255,.12); }
            .hero-country-total small { display:block; color:#bdd0e2; font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; font-weight:800; }
            .hero-country-total strong { display:block; margin-top:4px; color:#fff; font-size:20px; }

            .flag-wrap {
                width:58px; height:40px;
                border-radius:9px;
                overflow:hidden;
                border:2px solid rgba(255,255,255,.8);
                box-shadow:0 5px 12px rgba(0,0,0,.18);
                flex:0 0 auto;
                background:#fff;
            }
            .flag-wrap.small { width:34px; height:23px; border-width:1px; border-radius:5px; box-shadow:none; }
            .flag-svg { width:100%; height:100%; display:block; }
            .flag-placeholder { width:100%; height:100%; display:grid; place-items:center; color:#fff; font-weight:900; background:var(--primary); }

            .supported-countries { position:relative; z-index:2; display:flex; flex-direction:column; gap:8px; min-width:230px; }
            .supported-title { color:#abc2da; font-size:10px; font-weight:850; text-transform:uppercase; letter-spacing:.08em; margin-bottom:2px; }
            .country-chip {
                display:flex; align-items:center; gap:10px;
                padding:9px 11px;
                border-radius:12px;
                border:1px solid rgba(255,255,255,.12);
                background:rgba(255,255,255,.075);
                color:#f3f8fd;
                font-size:11.5px;
                font-weight:750;
            }

            .stepper {
                display:flex;
                align-items:center;
                gap:9px;
                flex-wrap:wrap;
                margin:18px 0;
                padding:8px;
                border-radius:16px;
                background:rgba(255,255,255,.60);
                border:1px solid rgba(199,212,226,.9);
                width:max-content;
                max-width:100%;
                box-shadow:var(--shadow-sm);
                backdrop-filter:blur(8px);
            }

            .review-stepper {
    flex-wrap: nowrap;
}

                .page.no-header {
    padding-top: 12px;
}

/* ============================================================
   BARRA DE NAVEGACIÓN - PANTALLA DE REVISIÓN
   ============================================================ */

.review-toolbar {
    width: 100%;

    display: flex;
    align-items: center;
    justify-content: space-between;

    gap: 18px;

    margin: 0 0 18px;

    padding: 8px 10px;

    border: 1px solid #cbd8e6;

    border-radius: 16px;

    background:
        linear-gradient(
            135deg,
            rgba(255, 255, 255, .92),
            rgba(241, 247, 253, .94)
        );

    box-shadow:
        0 5px 18px rgba(15, 39, 70, .08);

    backdrop-filter:
        blur(10px);
}


/* El stepper ya no necesita margen externo */

.review-toolbar .stepper {
    margin: 0;

    padding: 0;

    border: 0;

    box-shadow: none;

    background: transparent;
}


/* Botones del lado derecho */

.review-toolbar-actions {
    display: flex;

    align-items: center;

    justify-content: flex-end;

    gap: 9px;

    margin-left: auto;

    flex-shrink: 0;
}


/* Regresar */

.review-back-btn {
    background: #ffffff;

    color: #34495f;

    border: 1px solid #c9d5e2;

    box-shadow:
        0 2px 5px rgba(15, 39, 70, .04);
}


.review-back-btn:hover {
    background: #f2f6fa;

    border-color: #aebdcd;
}


/* Crear factura más compacto para esta barra */

.review-toolbar-actions .btn {
    min-height: 40px;

    padding-left: 17px;

    padding-right: 17px;

    white-space: nowrap;
}

            .step {
                display:inline-flex; align-items:center; gap:8px;
                padding:8px 12px;
                border-radius:11px;
                color:#5c6c81;
                font-size:11.5px;
                font-weight:750;
            }
            .step b {
                width:24px; height:24px; display:grid; place-items:center;
                border-radius:8px; background:#e6edf5; color:#4b5f75; font-size:10.5px;
            }
            .step.active {
                background:linear-gradient(135deg, #1463ff, #0a4dcc);
                color:#fff;
                box-shadow:0 7px 18px rgba(20,99,255,.22);
            }
            .step.active b { background:rgba(255,255,255,.18); color:#fff; }

            .card {
                background:rgba(255,255,255,.94);
                border:1px solid #d3deea;
                border-radius:var(--radius);
                box-shadow:var(--shadow-sm);
                overflow:hidden;
            }
            .card + .card { margin-top:16px; }
            .card.tinted { background:linear-gradient(180deg,#f8fbff,#f2f7fc); }
            .card-head {
                padding:18px 20px 15px;
                display:flex;
                justify-content:space-between;
                align-items:flex-start;
                gap:16px;
                border-bottom:1px solid #dfe7f0;
                background:linear-gradient(90deg, rgba(239,246,255,.92), rgba(255,255,255,.92));
            }
            .card-title { margin:0; font-size:15px; line-height:1.3; font-weight:850; color:var(--navy); }
            .card-subtitle { margin:5px 0 0; color:var(--muted); font-size:11.5px; line-height:1.5; }
            .card-body { padding:20px; }

            .upload-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
            .file-card {
                position:relative;
                display:flex;
                flex-direction:column;
                min-height:208px;
                border:1.5px dashed #b8cae0;
                border-radius:16px;
                background:linear-gradient(145deg,#f7fbff,#edf5ff);
                padding:22px;
                cursor:pointer;
                transition:.18s ease;
            }
            .file-card.pdf { background:linear-gradient(145deg,#fbf9ff,#f1efff); border-color:#c6bdf5; }
            .file-card:hover,
            .file-card.has-file { transform:translateY(-2px); border-color:#6e9fff; box-shadow:0 12px 26px rgba(25,75,140,.11); }
            .file-card.has-file { background:linear-gradient(145deg,#eefbf5,#e4f7ee); border-color:#66c89d; }
            .file-badge-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
            .file-icon {
                width:48px; height:48px; border-radius:13px; display:grid; place-items:center;
                color:#0a4dcc; background:#dbe9ff; font-weight:900; font-size:12px;
                border:1px solid #c2d8ff;
            }
            .file-card.pdf .file-icon { color:#5b43b7; background:#ebe7ff; border-color:#d8d0ff; }
            .file-state {
                display:inline-flex; align-items:center; gap:6px; padding:5px 8px;
                border-radius:999px; background:#fff; border:1px solid #dbe4ee;
                color:#6b7a8c; font-size:9.5px; font-weight:800; text-transform:uppercase; letter-spacing:.05em;
            }
            .file-title { margin-top:24px; font-size:15px; font-weight:850; color:var(--navy); }
            .file-help { margin-top:5px; font-size:11.5px; color:var(--muted); line-height:1.5; }
            .file-selected {
                margin-top:auto; padding-top:17px; display:flex; align-items:center; justify-content:space-between;
                gap:12px; font-size:11.5px; font-weight:700; color:#384c62;
            }
            .file-selected span:first-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:72%; }
            .choose-file { color:#0a4dcc; font-weight:850; }
            .native-file { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }

            .info-strip { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:16px; }
            .info-item {
                position:relative;
                padding:14px 14px 14px 43px;
                border-radius:13px;
                background:#eef5fb;
                border:1px solid #dce7f2;
            }
            .info-item::before {
                content:'✓';
                position:absolute; left:14px; top:14px;
                width:20px; height:20px; border-radius:7px; display:grid; place-items:center;
                color:#fff; background:linear-gradient(145deg,#14b8a6,#0f8d83);
                font-size:11px; font-weight:900;
            }
            .info-item strong { display:block; font-size:11.5px; color:#203852; margin-bottom:4px; }
            .info-item span { font-size:10.5px; color:#68798c; line-height:1.45; }

            .actions { display:flex; align-items:center; justify-content:flex-end; gap:10px; margin-top:18px; }
            .btn {
                border:0; min-height:44px; padding:0 18px; border-radius:11px;
                font-family:inherit; font-size:12.5px; font-weight:850; cursor:pointer; transition:.16s ease;
                display:inline-flex; align-items:center; justify-content:center; gap:8px; text-decoration:none;
            }
            .btn-primary { background:linear-gradient(135deg,#1463ff,#0a4dcc); color:#fff; box-shadow:var(--shadow-blue); }
            .btn-primary:hover { transform:translateY(-1px); filter:brightness(.98); }
            .btn-primary:disabled { opacity:.55; cursor:default; transform:none; }
            .btn-secondary { background:#f2f6fa; color:#2d4359; border:1px solid #cbd6e2; }
            .btn-secondary:hover { background:#e9f0f6; }

            .summary-card { border-top:4px solid var(--country-accent); }
            .summary-grid { display:grid; grid-template-columns:1.15fr .8fr 1.3fr 1fr; gap:12px; }
            .summary-box {
                position:relative;
                padding:15px 16px;
                border:1px solid #d8e2ec;
                border-radius:13px;
                background:linear-gradient(180deg,#ffffff,#f5f8fb);
            }
            .summary-box.country-box { background:var(--country-soft); border-color:color-mix(in srgb, var(--country-accent) 34%, #d8e2ec); }
            .summary-label { font-size:9.5px; text-transform:uppercase; letter-spacing:.075em; color:#607086; font-weight:900; }
            .summary-value { margin-top:7px; font-size:14px; color:var(--navy); font-weight:850; word-break:break-word; }
            .summary-country { display:flex; align-items:center; gap:9px; }

            .status-pill {
                display:inline-flex; align-items:center; gap:7px; min-height:28px; padding:0 10px;
                border-radius:999px; font-size:10.5px; font-weight:850;
            }
            .status-pill.success { color:var(--success); background:var(--success-soft); border:1px solid #9fe2bd; }
            .status-pill.warning { color:var(--warning); background:var(--warning-soft); border:1px solid #efca89; }
            .status-pill::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; }

            .validation-layout {
                display:grid;
                grid-template-columns:minmax(0,.92fr) minmax(520px,1.08fr);
                gap:16px;
                align-items:start;
            }

            /* ============================================================
               REVISIÓN - NUEVA DISTRIBUCIÓN
               ============================================================ */

    .review-main-grid {
    display:grid;
    grid-template-columns:1fr;
    gap:16px;
    align-items:stretch;
    margin-top:16px;
}

            .review-main-grid > .card {
                margin-top:0;
                min-width:0;
                height:100%;
            }

            .review-full-width {
                margin-top:16px;
            }

            .review-full-width > .card {
                margin-top:0;
            }

            .review-admin-card .form-grid {
                grid-template-columns:repeat(4,minmax(0,1fr));
            }

            .review-admin-card .field.full {
                grid-column:1 / -1;
            }

            .review-admin-card .field.span-2 {
                grid-column:span 2;
            }

            .review-complement-card {
                margin-top:16px!important;
            }

            .stack { display:grid; gap:16px; }

            .invoice-card .card-head {
                background:linear-gradient(90deg,#eaf5ff,#f9fcff);
            }

            /*
             * Datos de la factura ocupa ahora todo el ancho.
             * Distribuimos importes y documentos en dos bloques
             * equilibrados para evitar grandes espacios vacíos.
             */
            .invoice-card .card-body {
                display:grid;
                grid-template-columns:minmax(360px,.82fr) minmax(480px,1.18fr);
                gap:14px;
                align-items:stretch;
            }

            .invoice-card .money-panel,
            .invoice-card .file-links {
                height:100%;
                align-items:stretch;
            }

            .invoice-card .money-box {
                min-height:86px;
                display:flex;
                flex-direction:column;
                justify-content:center;
            }

            .invoice-card .file-link {
                min-height:86px;
                padding:13px 16px;
                background:linear-gradient(180deg,#ffffff,#f4f8fc);
            }

            .invoice-card .file-link:hover {
                background:linear-gradient(180deg,#f7fbff,#edf4ff);
            }

            .admin-card { box-shadow:0 16px 36px rgba(23,61,103,.10); }
            .admin-card .card-head { background:linear-gradient(90deg,#e7f0ff,#f5f9ff); border-bottom-color:#d5e2f1; }
            .complement-card .card-head { background:linear-gradient(90deg,#edf8f5,#f8fcfb); }

            .form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 16px; }
            .field.full { grid-column:1 / -1; }
            .field label { display:flex; align-items:center; gap:3px; margin-bottom:6px; color:#2d4359; font-size:11.5px; font-weight:800; }
            .required { color:#d92d20; }

            input[type="text"], input[type="number"], input[type="date"], select, textarea {
                width:100%;
                border:1px solid #bfcbd8;
                border-radius:10px;
                background:#fbfdff;
                color:var(--text);
                font:inherit;
                font-size:12.5px;
                outline:none;
                box-shadow:inset 0 1px 2px rgba(15,39,70,.02);
                transition:.15s ease;
            }
            input[type="text"], input[type="number"], input[type="date"], select { min-height:42px; padding:0 11px; }
            textarea { min-height:92px; padding:10px 11px; resize:vertical; }
            select[multiple] { min-height:100px; padding:8px; }
            input:focus, select:focus, textarea:focus {
                border-color:#6f9eff;
                background:#fff;
                box-shadow:0 0 0 3px rgba(20,99,255,.10);
            }
            input:disabled, select:disabled, textarea:disabled { background:#e9eff5; color:#7e8da0; cursor:not-allowed; }
            .field-note { margin-top:5px; font-size:10px; color:#8290a0; line-height:1.4; }

            .money-panel { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
            .money-box {
                border-radius:13px;
                padding:15px;
                background:linear-gradient(145deg,#0e2b4a,#134f7f);
                border:1px solid rgba(255,255,255,.08);
                color:#fff;
                box-shadow:0 9px 20px rgba(10,45,79,.14);
            }
            .money-box:last-child { background:linear-gradient(145deg,#125bd8,#1463ff); }
            .money-box small { display:block; font-size:9px; color:#c9dcf0; text-transform:uppercase; letter-spacing:.07em; font-weight:900; }
            .money-box strong { display:block; margin-top:7px; color:#fff; font-size:19px; letter-spacing:-.02em; }

            .file-links { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
            .file-link {
                display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:56px;
                padding:0 14px; border:1px solid #cfdbe7; border-radius:11px; background:#f5f9fd;
                color:#34495f; text-decoration:none; transition:.16s ease;
            }
            .file-link:hover { border-color:#7fa8ff; background:#edf4ff; transform:translateY(-1px); }
            .file-link strong { display:block; font-size:11.5px; color:var(--navy); }
            .file-link span { display:block; font-size:10px; color:var(--muted); margin-top:2px; }
            .file-link b { color:#0a4dcc; font-size:10.5px; }

.tax-wrap {
    overflow-x:hidden;
    background:#f8fbfe;
}
                .tax-table { width:100%; border-collapse:collapse; min-width:700px; }
            .tax-table th {
                text-align:left; padding:10px 12px; font-size:9px; text-transform:uppercase; letter-spacing:.06em;
                color:#506378; background:#e9f0f7; border-bottom:1px solid #d7e1eb;
            }
            .tax-table td { padding:12px; font-size:11.5px; color:#34495f; border-bottom:1px solid #e3eaf1; vertical-align:middle; }
            .tax-table tbody tr:nth-child(even) { background:#f3f7fb; }
            .tax-table tr:last-child td { border-bottom:0; }
            .tax-amount { text-align:right; font-variant-numeric:tabular-nums; font-weight:850; color:var(--navy)!important; }
            .tax-code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:10.5px; background:#e4edf6; border-radius:7px; padding:4px 7px; display:inline-block; }
            .tax-missing { color:var(--danger); background:var(--danger-soft); border:1px solid #f1bbb6; border-radius:999px; padding:4px 8px; font-size:9.5px; font-weight:850; }

            .tax-manual-actions {
                display:flex;
                align-items:center;
                justify-content:flex-start;
                padding:12px 14px;
                border-top:1px solid #dce5ee;
                background:#f5f9fd;
            }

            .btn-tax-add {
                min-height:38px;
                padding:0 14px;
                border-radius:10px;
                border:1px solid #adc7ed;
                background:#eef5ff;
                color:#0a4dcc;
                font-size:11.5px;
                font-weight:850;
                cursor:pointer;
            }

            .btn-tax-add:disabled {
                opacity:.55;
                cursor:not-allowed;
                background:#eef2f6;
                color:#7e8da0;
                border-color:#ccd6e0;
            }

            .manual-tax-row {
                background:#fffaf0 !important;
            }

            .manual-tax-row select,
            .manual-tax-row input {
                min-height:36px;
                font-size:11.5px;
            }

            .manual-tax-remove {
                border:1px solid #efb6b2;
                background:#fff2f1;
                color:#b42318;
                border-radius:8px;
                min-height:34px;
                padding:0 10px;
                font-size:10.5px;
                font-weight:800;
                cursor:pointer;
            }

            .tax-manual-badge {
                display:inline-flex;
                align-items:center;
                padding:4px 7px;
                border-radius:999px;
                background:#fff1cf;
                border:1px solid #efd18b;
                color:#885400;
                font-size:9px;
                font-weight:850;
            }

            .manual-tax-preview {
                min-width:150px;
                padding:7px 9px;
                border:1px solid #cfe0f7;
                border-radius:9px;
                background:#f2f7ff;
                text-align:right;
            }

            .manual-tax-preview-label {
                display:block;
                color:#66758a;
                font-size:9px;
                font-weight:800;
                text-transform:uppercase;
                letter-spacing:.04em;
            }

            .manual-tax-formula {
                display:block;
                margin-top:2px;
                color:#52657a;
                font-size:9.5px;
                font-weight:700;
            }

            .manual-tax-calculated {
                display:block;
                margin-top:2px;
                color:#0a4dcc;
                font-size:13px;
                font-weight:900;
                font-variant-numeric:tabular-nums;
            }


            /* ============================================================
               DISTRIBUCIÓN MULTI-LÍNEA
               ============================================================ */

            .distribution-card {
                margin-top:16px;
                overflow:visible;
            }

            .distribution-summary {
                display:grid;
                grid-template-columns:repeat(3,minmax(0,1fr));
                gap:10px;
                padding:14px 18px;
                background:#f8fbfe;
                border-bottom:1px solid #dce5ee;
            }

            .distribution-summary-box {
                padding:12px 14px;
                border:1px solid #d8e2ec;
                border-radius:12px;
                background:#fff;
            }

            .distribution-summary-box small {
                display:block;
                color:#6b7c90;
                font-size:9.5px;
                font-weight:850;
                letter-spacing:.06em;
                text-transform:uppercase;
            }

            .distribution-summary-box strong {
                display:block;
                margin-top:5px;
                color:var(--navy);
                font-size:17px;
            }

            .distribution-summary-box.pending strong {
                color:var(--danger);
            }

            .distribution-summary-box.complete strong {
                color:var(--success);
            }

            .distribution-table-wrap {
                width:100%;
                overflow-x:auto;
            }

            .distribution-table {
                width:100%;
                min-width:1080px;
                border-collapse:collapse;
            }

            .distribution-table th {
                text-align:left;
                padding:10px 12px;
                background:#e9f0f7;
                border-bottom:1px solid #d7e1eb;
                color:#506378;
                font-size:9px;
                text-transform:uppercase;
                letter-spacing:.055em;
            }

            .distribution-table td {
                padding:11px 12px;
                border-bottom:1px solid #e3eaf1;
                vertical-align:top;
                font-size:11.5px;
                color:#34495f;
            }

            .distribution-table tbody tr:nth-child(even) {
                background:#f8fafc;
            }

            .distribution-mode {
                max-width:320px;
                margin-bottom:14px;
            }

            .distribution-select,
            .distribution-amount {
                min-height:38px!important;
                font-size:11.5px!important;
            }

            .distribution-amount {
                text-align:right;
                min-width:125px;
            }

            .distribution-igv {
                width:18px;
                height:18px;
                cursor:pointer;
            }

            .distribution-tax-list {
                display:flex;
                flex-wrap:wrap;
                gap:5px;
                min-width:300px;
            }

            .distribution-tax-pill {
                display:inline-flex;
                align-items:center;
                gap:4px;
                padding:5px 7px;
                border:1px solid #cbd9e8;
                border-radius:999px;
                background:#f2f7fc;
                color:#36516e;
                font-size:9.5px;
                font-weight:800;
            }

            .distribution-tax-pill.manual {
                border-color:#efd18b;
                background:#fff7df;
                color:#885400;
            }

            .distribution-tax-pill.missing {
                border-color:#f1bbb6;
                background:#fff0ef;
                color:#b42318;
            }

            .distribution-total {
                text-align:right;
                white-space:nowrap;
                font-variant-numeric:tabular-nums;
                font-weight:850;
                color:var(--navy);
            }

            .distribution-actions {
                display:flex;
                flex-wrap:wrap;
                gap:6px;
            }

            .distribution-btn {
                min-height:34px;
                padding:0 10px;
                border:1px solid #adc7ed;
                border-radius:9px;
                background:#eef5ff;
                color:#0a4dcc;
                font-size:10.5px;
                font-weight:850;
                cursor:pointer;
            }

            .distribution-btn:hover {
                background:#e1edff;
            }

            .distribution-btn.danger {
                border-color:#efb6b2;
                background:#fff2f1;
                color:#b42318;
            }

            .distribution-footer {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:12px;
                padding:13px 18px;
                background:#f5f9fd;
                border-top:1px solid #dce5ee;
            }

            .distribution-help {
                color:#6f7f91;
                font-size:10.5px;
                line-height:1.45;
            }

            @media (max-width:760px) {
                .distribution-summary {
                    grid-template-columns:1fr;
                }
            }

            .sticky-actions {
                position:sticky; bottom:12px; z-index:16; margin-top:18px; padding:12px 13px;
                border:1px solid #b9c9da;
                background:linear-gradient(90deg,rgba(9,31,54,.97),rgba(15,63,102,.97));
                backdrop-filter:blur(12px);
                border-radius:14px;
                box-shadow:0 14px 34px rgba(8,27,49,.22);
                display:flex; justify-content:space-between; align-items:center; gap:12px;
            }
            .sticky-copy { font-size:10.5px; color:#c6d8ea; line-height:1.45; }
            .sticky-actions .btn-secondary { background:rgba(255,255,255,.10); color:#fff; border-color:rgba(255,255,255,.18); }

            .swal2-popup { border-radius:18px!important; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important; box-shadow:0 24px 70px rgba(8,27,49,.24)!important; }
            .swal2-title { color:var(--navy)!important; font-size:20px!important; letter-spacing:-.02em!important; }
            .swal2-html-container,.swal2-content { color:var(--muted)!important; font-size:12.5px!important; }
            .swal2-confirm { background:linear-gradient(135deg,#1463ff,#0a4dcc)!important; border-radius:10px!important; font-weight:800!important; }
            .swal2-cancel { background:#eff3f7!important; color:#34495f!important; border:1px solid #c9d4df!important; border-radius:10px!important; font-weight:800!important; }

            @media (max-width:1080px) {
                .validation-layout { grid-template-columns:1fr; }
                .review-main-grid { grid-template-columns:1fr; }
                .invoice-card .card-body { grid-template-columns:1fr; }
                .review-admin-card .form-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
                .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
                .hero { align-items:flex-start; }
            }
            @media (max-width:760px) {
                .topbar { padding:0 17px; min-height:66px; }
                .top-status { display:none; }
                .page,.page--narrow { width:min(100% - 24px,1320px); padding-top:18px; }
                .hero { min-height:auto; padding:22px 19px; flex-direction:column; border-radius:18px; }
                .hero-country,.supported-countries { width:100%; min-width:0; }
                .upload-grid,.form-grid,.info-strip,.file-links,.money-panel { grid-template-columns:1fr; }
                .invoice-card .card-body { grid-template-columns:1fr; }
                .invoice-card .money-box,
                .invoice-card .file-link { min-height:72px; }
                .review-main-grid { grid-template-columns:1fr; }
                .review-admin-card .form-grid { grid-template-columns:1fr; }
                .review-admin-card .field.span-2 { grid-column:auto; }
                .summary-grid { grid-template-columns:1fr; }
                .card-head { padding:16px; }
                .card-body { padding:16px; }
                .stepper { width:100%; }
                .step { flex:1; min-width:145px; }
                .sticky-actions { align-items:stretch; flex-direction:column; bottom:7px; }
                .sticky-actions .actions { width:100%; margin:0; }
                .sticky-actions .btn { flex:1; }
                .review-toolbar {
    flex-direction: column;
    align-items: stretch;

    padding: 10px;
}


.review-toolbar .stepper {
    width: 100%;
}


.review-stepper {
    flex-wrap: wrap;
}


.review-toolbar-actions {
    width: 100%;

    margin-left: 0;
}


.review-toolbar-actions .btn {
    flex: 1;
}
            }
        </style>
    `;
        } catch (functionError) {
            logFunctionError('getBaseStyles', functionError);
            throw functionError;
        }
    };

    const getPageStart = ({
        title,
        subtitle = '',
        narrow = false,
        countryCode = '',
        countryName = '',
        totalText = '',
        showTopbar = true,
        showHero = true
    }) => {
        try {

            const countryClass =
                getCountryCssClass(
                    countryCode
                );


            const hasCountry =
                Boolean(
                    cleanText(countryCode)
                );


            const pageClasses = [
                'page',
                narrow
                    ? 'page--narrow'
                    : '',
                !showTopbar && !showHero
                    ? 'no-header'
                    : ''
            ]
                .filter(Boolean)
                .join(' ');


            // resto...
            const sideContent = hasCountry
                ? `
                <div class="hero-country">
                    <div class="hero-country-top">
                        <div class="flag-wrap">${getCountryFlagSvg(countryCode)}</div>
                        <div>
                            <div class="hero-country-name">${escapeHtml(countryName || countryCode)}</div>
                            <div class="hero-country-caption">País detectado en el XML</div>
                        </div>
                    </div>
                    ${totalText ? `
                        <div class="hero-country-total">
                            <small>Total del comprobante</small>
                            <strong>${escapeHtml(totalText)}</strong>
                        </div>
                    ` : ''}
                </div>
            `
                : `
                <div class="supported-countries">
                    <div class="supported-title">Países disponibles</div>
                    <div class="country-chip"><span class="flag-wrap small">${getCountryFlagSvg('MX')}</span> México · CFDI</div>
                    <div class="country-chip"><span class="flag-wrap small">${getCountryFlagSvg('PE')}</span> Perú · SUNAT</div>
                    <div class="country-chip"><span class="flag-wrap small">${getCountryFlagSvg('CO')}</span> Colombia · DIAN</div>
                </div>
            `;

            return `
    <!DOCTYPE html>
    <html lang="es">

    <head>

        <meta charset="UTF-8">

        <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
        >

        <title>
            ${escapeHtml(title)}
        </title>

        <script
            src="https://cdn.jsdelivr.net/npm/sweetalert2@11">
        </script>

        ${getBaseStyles()}

    </head>

    <body>

        <div class="app-shell ${countryClass}">


            ${showTopbar ? `

                <header class="topbar">

                    <div class="brand">

                        <div class="brand-mark">
                            FE
                        </div>

                        <div class="brand-copy">

                            <div class="brand-title">
                                Facturación electrónica
                            </div>

                            <div class="brand-subtitle">
                                Planificador de gastos · NetSuite
                            </div>

                        </div>

                    </div>


                    <div class="top-status">
                        NetSuite conectado
                    </div>

                </header>

            ` : ''}


<main class="${pageClasses}">


                ${showHero ? `

                    <section class="hero">

                        <div class="hero-copy">

                            <div class="hero-kicker">
                                Planificador de gastos · Facturación electrónica
                            </div>

                            <h1>
                                ${escapeHtml(title)}
                            </h1>


                            ${subtitle ? `

                                <p class="lead">
                                    ${escapeHtml(subtitle)}
                                </p>

                            ` : ''}

                        </div>


                        ${sideContent}

                    </section>

                ` : ''}
`;
        } catch (functionError) {
            logFunctionError('getPageStart', functionError);
            throw functionError;
        }
    };

    const getPageEnd = () => {
        try {
            return `
                    </main>
                </div>
            </body>
            </html>
        `;
        } catch (functionError) {
            logFunctionError('getPageEnd', functionError);
            throw functionError;
        }
    };

    const renderUploadForm = (context, params) => {
        try {
            const plannerHomeUrl = getPlannerHomeUrl();
            const showSuccess = params.success === '1';
            const transactionNumber = cleanText(params.transactionNumber);
            const billId = cleanText(params.billId);
            const vendorBillUrl = billId
                ? '/app/accounting/transactions/vendbill.nl?id=' + encodeURIComponent(billId)
                : '';

            const html = `
       ${getPageStart({
                title: 'Carga y validación de factura',

                subtitle:
                    'Adjunta el XML fiscal y el PDF de respaldo. ' +
                    'El sistema detectará México, Perú o Colombia y ' +
                    'preparará automáticamente los datos fiscales ' +
                    'antes de crear la factura.',

                narrow: true,

                showTopbar: false,
                showHero: false
            })}

            <div class="stepper">
                <div class="step active"><b>1</b> Cargar archivos</div>
                <div class="step"><b>2</b> Revisar información</div>
                <div class="step"><b>3</b> Crear factura</div>
            </div>

            <form id="uploadForm" method="post" enctype="multipart/form-data" action="">
                <section class="card tinted">
                    <div class="card-head">
                        <div>
                            <h2 class="card-title">Documentos del comprobante</h2>
                            <p class="card-subtitle">Carga ambos archivos. No se guardará nada en NetSuite hasta que la validación termine correctamente.</p>
                        </div>
                        <span class="status-pill success">Validación segura</span>
                    </div>

                    <div class="card-body">
                        <div class="upload-grid">
                         <label class="file-card" id="xmlCard" for="custpage_xml">
    <input
        class="native-file"
        id="custpage_xml"
        name="custpage_xml"
        type="file"
        accept=".xml,text/xml,application/xml"
    >

    <div class="file-badge-row">
        <div class="file-icon">XML</div>
        <span class="file-state">Fiscal</span>
    </div>

    <div class="file-title">
        Comprobante fiscal electrónico
    </div>

    <div class="file-help">
        CFDI para México o UBL electrónico para Perú y Colombia.
    </div>

    <div class="file-selected">
        <span id="xmlFileName" class="file-name empty">
            Ningún archivo seleccionado
        </span>

        <span class="choose-file">
            Elegir XML
        </span>
    </div>
</label>


<label class="file-card pdf" id="pdfCard" for="custpage_pdf">
    <input
        class="native-file"
        id="custpage_pdf"
        name="custpage_pdf"
        type="file"
        accept=".pdf,application/pdf"
    >

    <div class="file-badge-row">
        <div class="file-icon">PDF</div>
        <span class="file-state">Soporte</span>
    </div>

    <div class="file-title">
        Documento de respaldo
    </div>

    <div class="file-help">
        PDF correspondiente al mismo comprobante que será validado.
    </div>

    <div class="file-selected">
        <span id="pdfFileName" class="file-name empty">
            Ningún archivo seleccionado
        </span>

        <span class="choose-file">
            Elegir PDF
        </span>
    </div>
</label>
                        </div>

                        <div class="info-strip">
                            <div class="info-item">
                                <strong>Detección fiscal automática</strong>
                                <span>Identifica CFDI, SUNAT o DIAN y obtiene la información clave del XML.</span>
                            </div>
                            <div class="info-item">
                                <strong>Control de duplicados</strong>
                                <span>Verifica que el comprobante no exista antes de continuar.</span>
                            </div>
                            <div class="info-item">
                                <strong>Preparación para NetSuite</strong>
                                <span>Proveedor, subsidiaria, moneda e impuestos quedan listos para revisión.</span>
                            </div>
                        </div>
                    </div>
                </section>

                <div class="actions">
                    <button class="btn btn-primary" id="validateButton" type="button" onclick="validarArchivosAjax()">
                        Validar y continuar
                    </button>
                </div>
            </form>

            <script>
                (function () {
                    var processing = false;
                    var xmlInput = document.getElementById('custpage_xml');
                    var pdfInput = document.getElementById('custpage_pdf');
                    var xmlName = document.getElementById('xmlFileName');
                    var pdfName = document.getElementById('pdfFileName');
                    var xmlCard = document.getElementById('xmlCard');
                    var pdfCard = document.getElementById('pdfCard');
                    var button = document.getElementById('validateButton');
function syncFile(
    input,
    label,
    card
) {

    const hasFile =
        input &&
        input.files &&
        input.files.length > 0;


    if (hasFile) {

        const selectedFile =
            input.files[0];


        // Nombre real del archivo
        label.textContent =
            selectedFile.name;


        // Estado visual del texto
        label.classList.remove(
            'empty'
        );

        label.classList.add(
            'selected'
        );


        // Estado visual de la tarjeta
        card.classList.add(
            'has-file'
        );


    } else {

        label.textContent =
            'Ningún archivo seleccionado';


        label.classList.remove(
            'selected'
        );

        label.classList.add(
            'empty'
        );


        card.classList.remove(
            'has-file'
        );
    }
}
                    xmlInput.addEventListener('change', function () {
                        syncFile(xmlInput, xmlName, xmlCard);
                    });

                    pdfInput.addEventListener('change', function () {
                        syncFile(pdfInput, pdfName, pdfCard);
                    });

                    window.validarArchivosAjax = async function () {
                        if (processing) return;

                        var form = document.getElementById('uploadForm');
                        var xmlFile = xmlInput && xmlInput.files && xmlInput.files.length
                            ? xmlInput.files[0]
                            : null;
                        var pdfFile = pdfInput && pdfInput.files && pdfInput.files.length
                            ? pdfInput.files[0]
                            : null;

                        if (!xmlFile || !pdfFile) {
                            Swal.fire({
                                icon: 'warning',
                                title: 'Completa los documentos',
                                html: '<b>Falta información.</b><br>Selecciona el XML de la factura y su PDF de respaldo para continuar.',
                                confirmButtonText: 'Seleccionar archivos'
                            });
                            return;
                        }

                        if (!xmlFile.name.toLowerCase().endsWith('.xml')) {
                            Swal.fire({
                                icon: 'error',
                                title: 'XML no válido',
                                html: 'El comprobante fiscal debe tener extensión <b>.xml</b>. Revisa el archivo seleccionado.',
                                confirmButtonText: 'Revisar XML'
                            });
                            return;
                        }

                        if (!pdfFile.name.toLowerCase().endsWith('.pdf')) {
                            Swal.fire({
                                icon: 'error',
                                title: 'PDF no válido',
                                html: 'El soporte documental debe tener extensión <b>.pdf</b>. Revisa el archivo seleccionado.',
                                confirmButtonText: 'Revisar PDF'
                            });
                            return;
                        }

                        try {
                            processing = true;
                            button.disabled = true;

                            Swal.fire({
                                title: 'Validando comprobante',
                                html: '<div style="line-height:1.6">Estamos leyendo el XML, validando duplicados y preparando la configuración fiscal de NetSuite.</div>',
                                allowOutsideClick: false,
                                allowEscapeKey: false,
                                showConfirmButton: false,
                                didOpen: function () { Swal.showLoading(); }
                            });

                            var formData = new FormData(form);
                            formData.set('custpage_ajax_request', 'T');

                            var response = await fetch(window.location.href, {
                                method: 'POST',
                                body: formData,
                                credentials: 'same-origin'
                            });

                            var contentType = response.headers.get('content-type') || '';

                            if (contentType.toLowerCase().includes('application/json')) {
                                var result = await response.json();
                                if (!response.ok || result.success === false) {
                                    throw new Error(result.message || 'No fue posible validar la factura.');
                                }
                                return;
                            }

                            var html = await response.text();
                            document.open();
                            document.write(html);
                            document.close();

                        } catch (error) {
                            Swal.fire({
                                icon: 'error',
                                title: 'No fue posible validar la factura',
                                html: '<div style="line-height:1.55">' +
                                    String(error.message || 'Ocurrió un error durante la validación.') +
                                    '</div>',
                                confirmButtonText: 'Entendido'
                            });
                        } finally {
                            processing = false;
                            button.disabled = false;
                        }
                    };

                    ${showSuccess ? `
                        document.addEventListener('DOMContentLoaded', function () {
                            Swal.fire({
                                icon: 'success',
                                title: 'Factura creada correctamente',
                                html: '<div style="line-height:1.6">Transacción <b>${escapeHtml(transactionNumber || '')}</b> creada en NetSuite.</div>',
                                showCancelButton: true,
                                confirmButtonText: 'Ver factura',
                                cancelButtonText: 'Volver al inicio',
                                allowOutsideClick: false,
                                allowEscapeKey: false
                            }).then(function (result) {
                                if (result.isConfirmed && ${JSON.stringify(vendorBillUrl)} ) {
                                    window.open(${JSON.stringify(vendorBillUrl)}, '_blank');
                                }
                                window.location.href = ${JSON.stringify(plannerHomeUrl)};
                            });
                        });
                    ` : ''}
                })();
            </script>

            ${getPageEnd()}
        `;

            writeHtml(context, html);
        } catch (functionError) {
            logFunctionError('renderUploadForm', functionError);
            throw functionError;
        }
    };

    const renderTaxRows = taxes => {
        try {
            const rows = (taxes || []).map((item, index) => {
                const options = Array.isArray(item.taxOptions)
                    ? item.taxOptions
                    : [];

                let taxControl = '';

                if (options.length > 1) {
                    taxControl = `
                    <select
                        id="custpage_tax_mapping_${index}"
                        name="custpage_tax_mapping_${index}"
                        required
                    >
                        <option value="">Selecciona código NetSuite</option>
                        ${options.map(option => `
                            <option value="${escapeHtml(option.taxId)}">
                                ${escapeHtml(option.taxName || `Código ${option.taxId}`)}
                            </option>
                        `).join('')}
                    </select>
                `;
                } else if (item.taxName) {
                    taxControl = `<span>${escapeHtml(item.taxName)}</span>`;
                } else {
                    taxControl = '<span class="tax-missing">Sin configurar</span>';
                }

                return `
                <tr>
                    <td>${escapeHtml(item.type || '')}</td>
                    <td><span class="tax-code">${escapeHtml(item.authorityCode || item.name || '')}</span></td>
                    <td>${escapeHtml(item.rate)}%</td>
                    <td>${taxControl}</td>
                    <td class="tax-amount">${toNumber(item.amount).toFixed(2)}</td>
                </tr>
            `;
            }).join('');

            return rows || `
            <tr data-empty-tax-row="T">
                <td colspan="5" style="text-align:center;color:#98a2b3;padding:24px;">
                    No se detectaron impuestos en el XML.
                </td>
            </tr>
        `;
        } catch (functionError) {
            logFunctionError('renderTaxRows', functionError);
            throw functionError;
        }
    };

    const renderValidationForm = (context, data) => {
        try {
            const plannerHomeUrl = getPlannerHomeUrl();
            const invoice = data.invoice;
            const countryConfig = CONFIG.COUNTRY[invoice.countryCode];
            const subsidiaryIds = getSubsidiaryIdsByCountry(invoice.countryCode);

            const categoryOptions = getExpenseCategoryOptions(subsidiaryIds);
            // Sólo artículos de la subsidiaria a la que se cargará la factura
            // (la resuelta por findSubsidiary con la identificación del receptor).
            const itemOptions = getPlannerItemOptions([data.subsidiary.id]);

            // Perú entra por defecto al proceso de artículos; el resto, por gastos.
            const defaultLineMode = invoice.countryCode === 'PE' ? 'ITEMS' : 'EXPENSES';

            log.audit({
                title: 'Artículos del planificador',
                details: {
                    subsidiaryId: data.subsidiary.id,
                    total: itemOptions.length
                }
            });

            const locationOptions =
                getLocationOptions(
                    subsidiaryIds
                );

            /*
             * Regional por defecto:
             * se toma de la Location/Regional asignada al usuario actual.
             * Si no existe o no pertenece a las opciones del país, queda vacío.
             */
            const defaultRegionalId =
                getCurrentUserRegionalDefault(
                    locationOptions
                );

            const brandOptions =
                getBrandOptionsByCountry(
                    invoice.countryCode
                );
            const departmentOptions = getDepartmentOptions();
            const bankOptions =
                getBankOptions(
                    invoice.countryCode
                );
            const plateOptions = countryConfig.plateRecord
                ? getSimpleRecordOptions(countryConfig.plateRecord)
                : [];

            const defaultTaxId = runtime.getCurrentScript().getParameter({
                name: 'custscript_iva_default'
            }) || '';

            const hasConfiguredMainTax = invoice.taxes.some(item =>
                ['TRANSFER', 'EXEMPT', 'UNAFFECTED'].includes(item.type) &&
                (
                    item.taxId ||
                    (Array.isArray(item.taxOptions) && item.taxOptions.length)
                )
            );

            const hasUnmappedWithholding = invoice.taxes.some(item =>
                ['WITHHOLDING', 'DETRACTION'].includes(item.type) &&
                !item.taxId &&
                !(
                    Array.isArray(item.taxOptions) &&
                    item.taxOptions.length
                )
            );

            const taxOptions =
                getTaxItemOptionsByCountry(
                    invoice.countryCode
                );

            let currencyOptions = [];
            let currencyDefault = '';

            if (data.vendorId) {
                const currencies = getVendorCurrencies(data.vendorId);
                currencyOptions = (currencies.values || []).map(item => ({
                    value: item.id,
                    text: item.name
                }));
                currencyDefault = currencies.primary || '';
            }

            let bankAccountValue = '';
            let bankValue = '';

            if (data.vendorId) {
                const accountResults = search.create({
                    type: 'customrecord_ce_cue_ent',
                    filters: [
                        ['custrecord_ce_cue_ent_entidad', 'anyof', data.vendorId]
                    ],
                    columns: [
                        'custrecord_ce_cue_ent_cuenta',
                        'custrecord_ce_cue_ent_banco_nal'
                    ]
                }).run().getRange({ start: 0, end: 1 });

                if (accountResults.length) {
                    bankAccountValue = accountResults[0].getValue('custrecord_ce_cue_ent_cuenta') || '';
                    bankValue = accountResults[0].getValue('custrecord_ce_cue_ent_banco_nal') || '';
                }
            }

            const supplierTaxLabel = invoice.countryCode === 'MX'
                ? 'RFC del proveedor'
                : invoice.countryCode === 'PE'
                    ? 'RUC del proveedor'
                    : invoice.countryCode === 'CO'
                        ? 'NIT del proveedor'
                        : 'Identificación fiscal';

            const issueDate =
                formatHtmlDate(
                    invoice.issueDate
                );


            const isEditableIssueDate =
                ['PE', 'CO'].includes(
                    cleanText(invoice.countryCode).toUpperCase()
                );


            const countryCode =
                cleanText(invoice.countryCode).toUpperCase();

            const dueDate =
                formatHtmlDate(
                    countryCode === 'CO'
                        ? getNextWednesday()
                        : getNextThursday()
                );

            const invoiceJson =
                escapeHtml(
                    JSON.stringify(invoice)
                );
            const taxesJson = escapeHtml(JSON.stringify(invoice.taxes));
            const totalText = `${invoice.currencyCode || ''} ${toNumber(invoice.total).toFixed(2)}`;

            const html = `
         ${getPageStart({
                title: 'Revisión del comprobante',

                subtitle:
                    `La factura fue validada para ${invoice.countryName}. ` +
                    `Revisa la información fiscal y completa los datos administrativos ` +
                    `antes de crear la transacción.`,

                countryCode:
                    invoice.countryCode,

                countryName:
                    invoice.countryName,

                totalText,

                // Ocultar todo lo superior
                showTopbar: false,
                showHero: false
            })}

<div class="review-toolbar">

    <div class="stepper review-stepper">

        <div class="step">
            <b>1</b>
            Archivos cargados
        </div>

        <div class="step active">
            <b>2</b>
            Revisar información
        </div>

        <div class="step">
            <b>3</b>
            Crear factura
        </div>

    </div>


    <div class="review-toolbar-actions">

        <button
            class="btn btn-secondary review-back-btn"
            type="button"
            onclick="regresarCargaFactura()"
        >
            ← Regresar
        </button>


        <button
            class="btn btn-primary"
            id="createButton"
            type="button"
            onclick="crearFacturaAjax()"
        >
            Crear factura
        </button>

    </div>

</div>

            <form id="createInvoiceForm" method="post" action="">
                <input type="hidden" name="custpage_step" value="create">
                <input type="hidden" name="custpage_proveedor_nuevo" value="${data.vendorId ? 'F' : 'T'}">
                <input type="hidden" name="custpage_vendorid" value="${escapeHtml(data.vendorId || '')}">
                <input type="hidden" name="custpage_subsidiaria" value="${escapeHtml(data.subsidiary.id)}">
                <input type="hidden" name="custpage_xml_id" value="${escapeHtml(data.xmlFile.id)}">
                <input type="hidden" name="custpage_pdf_id" value="${escapeHtml(data.pdfFile.id)}">
                <input type="hidden" name="custpage_invoice_json" value="${invoiceJson}">
                <input type="hidden" name="custpage_taxes_json" value="${taxesJson}">
                <input
                    type="hidden"
                    id="custpage_manual_taxes_json"
                    name="custpage_manual_taxes_json"
                    value="[]"
                >

                <input
                    type="hidden"
                    id="custpage_expense_distribution_json"
                    name="custpage_expense_distribution_json"
                    value="[]"
                >
                ${hasConfiguredMainTax ? '<input type="hidden" name="custpage_impuesto" value="">' : ''}
                ${!hasUnmappedWithholding ? '<input type="hidden" name="custpage_retenciones" value="">' : ''}
                ${!countryConfig.plateRecord ? '<input type="hidden" name="custpage_placas" value="">' : ''}
                ${!data.vendorId ? '<input type="hidden" name="custpage_moneda" value="">' : ''}

                <section class="card summary-card">
                    <div class="card-head">
                        <div>
                            <h2 class="card-title">Resumen del comprobante</h2>
                            <p class="card-subtitle">Información fiscal obtenida directamente del XML.</p>
                        </div>
                        <span class="status-pill success">XML validado</span>
                    </div>
                    <div class="card-body">
                        <div class="summary-grid">
                            <div class="summary-box">
                                <div class="summary-label">Documento</div>
                                <div class="summary-value">${escapeHtml(invoice.documentNumber || invoice.documentId || '—')}</div>
                            </div>
                            <div class="summary-box country-box">
                                <div class="summary-label">País</div>
                                <div class="summary-value summary-country">
                                    <span class="flag-wrap small">${getCountryFlagSvg(invoice.countryCode)}</span>
                                    <span>${escapeHtml(invoice.countryName || '—')}</span>
                                </div>
                            </div>
                            <div class="summary-box">
                                <div class="summary-label">Proveedor</div>
                                <div class="summary-value">${escapeHtml(invoice.supplierName || 'Sin nombre')}</div>
                            </div>
                            <div class="summary-box">
                                <div class="summary-label">${escapeHtml(supplierTaxLabel)}</div>
                                <div class="summary-value">${escapeHtml(invoice.supplierTaxId || '—')}</div>
                            </div>
                        </div>
                    </div>
                </section>

                <div class="review-main-grid">

                    <!-- IZQUIERDA: DATOS DE LA FACTURA -->
                    <section class="card invoice-card">
                        <div class="card-head">
                            <div>
                                <h2 class="card-title">Datos de la factura</h2>
                                <p class="card-subtitle">Importes principales y documentos de soporte.</p>
                            </div>

                            <span class="status-pill ${data.vendorId ? 'success' : 'warning'}">
                                ${data.vendorId
                    ? `Proveedor existente · ID ${escapeHtml(data.vendorId)}`
                    : 'Proveedor nuevo'}
                            </span>
                        </div>

                        <div class="card-body">
                            <div class="money-panel">
                                <div class="money-box">
                                    <small>Subtotal</small>
                                    <strong>
                                        ${escapeHtml(invoice.currencyCode || '')}
                                        ${toNumber(invoice.subtotal).toFixed(2)}
                                    </strong>
                                </div>

                                <div class="money-box">
                                    <small>Total XML</small>
                                    <strong>
                                        ${escapeHtml(invoice.currencyCode || '')}
                                        ${toNumber(invoice.total).toFixed(2)}
                                    </strong>
                                </div>
                            </div>

                            <div class="file-links" style="margin-top:12px;">
                                <a
                                    class="file-link"
                                    href="${escapeHtml(data.xmlFile.url)}"
                                    target="_blank"
                                    rel="noopener"
                                >
                                    <div>
                                        <strong>XML fiscal</strong>
                                        <span>Comprobante electrónico validado</span>
                                    </div>
                                    <b>Abrir XML</b>
                                </a>

                                <a
                                    class="file-link"
                                    href="${escapeHtml(data.pdfFile.url)}"
                                    target="_blank"
                                    rel="noopener"
                                >
                                    <div>
                                        <strong>PDF soporte</strong>
                                        <span>Documento adjunto de respaldo</span>
                                    </div>
                                    <b>Abrir PDF</b>
                                </a>
                            </div>
                        </div>
                    </section>


                </div>


                <!-- DISTRIBUCIÓN DE GASTOS E IMPUESTOS A TODO EL ANCHO -->
                <section class="card distribution-card">

                    <div class="card-head">
                        <div>
                            <h2 class="card-title">
                                Distribución de gastos e impuestos
                            </h2>

                            <p class="card-subtitle" id="distributionSubtitle">
                            </p>
                        </div>

                        <span class="status-pill success" id="distributionModePill">
                        </span>
                    </div>


                    <div class="field distribution-mode">
                        <label for="custpage_tipo_linea">
                            Registrar la factura por <span class="required">*</span>
                        </label>

                        <select
                            id="custpage_tipo_linea"
                            name="custpage_tipo_linea"
                            required
                        >
                            <option value="ITEMS"${defaultLineMode === 'ITEMS' ? ' selected' : ''}>Artículos</option>
                            <option value="EXPENSES"${defaultLineMode === 'EXPENSES' ? ' selected' : ''}>Gastos</option>
                        </select>
                    </div>


                    <div class="distribution-summary">

                        <div class="distribution-summary-box">
                            <small>Subtotal XML</small>
                            <strong>
                                ${escapeHtml(invoice.currencyCode || '')}
                                ${toNumber(invoice.subtotal).toFixed(2)}
                            </strong>
                        </div>

                        <div class="distribution-summary-box">
                            <small>Distribuido</small>
                            <strong id="distributionAssigned">
                                ${escapeHtml(invoice.currencyCode || '')} 0.00
                            </strong>
                        </div>

                        <div
                            class="distribution-summary-box pending"
                            id="distributionPendingBox"
                        >
                            <small>Pendiente por distribuir</small>

                            <strong id="distributionPending">
                                ${escapeHtml(invoice.currencyCode || '')}
                                ${toNumber(invoice.subtotal).toFixed(2)}
                            </strong>
                        </div>

                        <div class="distribution-summary-box">
                            <small>Total previo</small>
                            <strong id="distributionPreviewTotal">
                                ${escapeHtml(invoice.currencyCode || '')} 0.00
                            </strong>
                        </div>

                    </div>


                    <div class="distribution-table-wrap">

                        <table class="distribution-table">

                            <thead>
                                <tr>
                                    <th style="width:24%;" id="distributionTargetHeader">
                                    </th>

                                    ${invoice.countryCode === 'PE' ? `
                                        <th style="width:8%;text-align:center;" id="distributionIgvHeader">
                                            Aplica IGV
                                        </th>
                                    ` : ''}

                                    <th style="width:13%;text-align:right;">
                                        Base / importe
                                    </th>

                                    <th style="width:35%;">
                                        Impuestos asociados
                                    </th>

                                    <th style="width:12%;text-align:right;">
                                        Total línea
                                    </th>

                                    <th style="width:16%;">
                                        Acciones
                                    </th>
                                </tr>
                            </thead>

                            <tbody id="expenseDistributionBody">
                            </tbody>

                        </table>

                    </div>


                    <div class="distribution-footer">

                        <div class="distribution-help">
                            La suma de las bases debe ser exactamente igual al subtotal del XML.
                        </div>

                        <button
                            class="distribution-btn"
                            id="addExpenseDistributionLine"
                            type="button"
                        >
                        </button>

                    </div>

                </section>


                <!-- DATOS ADMINISTRATIVOS A TODO EL ANCHO -->
                <div class="review-full-width">

                    <section class="card admin-card review-admin-card">
                        <div class="card-head">
                            <div>
                                <h2 class="card-title">Datos administrativos</h2>
                                <p class="card-subtitle">
                                    Completa los datos necesarios para registrar la factura en NetSuite.
                                </p>
                            </div>
                        </div>

                        <div class="card-body">
                            <div class="form-grid">

                                ${data.vendorId ? `
                                    <div class="field">
                                        <label for="custpage_moneda">
                                            Moneda <span class="required">*</span>
                                        </label>

                                        <select
                                            id="custpage_moneda"
                                            name="custpage_moneda"
                                            required
                                        >
                                            ${renderOptions(
                        currencyOptions,
                        currencyDefault,
                        'Selecciona una moneda'
                    )}
                                        </select>
                                    </div>
                                ` : ''}

                                <div class="field">
                                    <label for="custpage_fecha_emision">
                                        Fecha de emisión XML
                                    </label>

                                    <input
                                        id="custpage_fecha_emision"
                                        name="custpage_fecha_emision"
                                        type="date"
                                        value="${escapeHtml(issueDate)}"
                                        ${isEditableIssueDate ? '' : 'readonly'}
                                        required
                                    >

                                    <div class="field-note">
                                        Fecha obtenida directamente del comprobante electrónico.
                                    </div>
                                </div>

                                <div class="field">
                                    <label for="custpage_vencimiento">
                                        Fecha de vencimiento
                                    </label>

                                    <input
                                        id="custpage_vencimiento"
                                        name="custpage_vencimiento"
                                        type="date"
                                        value="${escapeHtml(dueDate)}"
                                    >
                                </div>

                                <div class="field span-2">
                                    <label for="custpage_descripcion">
                                        Descripción
                                        <span class="required">*</span>
                                    </label>

                                    <input
                                        id="custpage_descripcion"
                                        name="custpage_descripcion"
                                        type="text"
                                        maxlength="300"
                                        required
                                        placeholder="Describe brevemente el gasto"
                                    >
                                </div>

                                <div class="field span-2">
                                    <label for="custpage_justificacion">
                                        Justificación
                                    </label>

                                    <textarea
                                        id="custpage_justificacion"
                                        name="custpage_justificacion"
                                        placeholder="Agrega el contexto o la justificación de la factura"
                                    ></textarea>
                                </div>

                                <div class="field">
                                    <label for="custpage_ubicacion">
                                        Regional <span class="required">*</span>
                                    </label>

                                    <select
                                        id="custpage_ubicacion"
                                        name="custpage_ubicacion"
                                        required
                                    >
                                        ${renderOptions(
                        locationOptions,
                        defaultRegionalId,
                        'Selecciona una regional'
                    )}
                                    </select>
                                </div>

                                <div class="field">
                                    <label for="custpage_marca">
                                        Marca <span class="required">*</span>
                                    </label>

                                    <select
                                        id="custpage_marca"
                                        name="custpage_marca"
                                        required
                                    >
                                        ${renderOptions(
                        brandOptions,
                        '',
                        'Selecciona una marca'
                    )}
                                    </select>
                                </div>

                                <div class="field">
                                    <label for="custpage_departamento">
                                        Departamento <span class="required">*</span>
                                    </label>

                                    <select
                                        id="custpage_departamento"
                                        name="custpage_departamento"
                                        required
                                    >
                                        ${renderOptions(
                        departmentOptions,
                        '',
                        'Selecciona un departamento'
                    )}
                                    </select>
                                </div>

                                <div class="field">
                                    <label for="custpage_total_esperado">
                                        Total esperado
                                    </label>

                                    <input
                                        id="custpage_total_esperado"
                                        name="custpage_total_esperado"
                                        type="number"
                                        step="0.01"
                                        value="${toNumber(invoice.total).toFixed(2)}"
                                    >
                                </div>

                                <input
                                    type="hidden"
                                    name="custpage_subtotal"
                                    value="${toNumber(invoice.subtotal)}"
                                >

                                <input
                                    type="hidden"
                                    name="custpage_total"
                                    value="${toNumber(invoice.total)}"
                                >

                            </div>
                        </div>
                    </section>


                    <!-- INFORMACIÓN COMPLEMENTARIA TAMBIÉN A TODO EL ANCHO -->
                    <section class="card complement-card review-complement-card">
                        <div class="card-head">
                            <div>
                                <h2 class="card-title">Información complementaria</h2>
                                <p class="card-subtitle">
                                    Datos bancarios, vehículo e impuestos manuales cuando apliquen.
                                </p>
                            </div>
                        </div>

                        <div class="card-body">
                            <div class="form-grid">

                                <div class="field">
                                    <label for="custpage_cuenta_bancaria">
                                        ${escapeHtml(countryConfig.bankAccountLabel)}
                                        ${!data.vendorId
                    ? ' <span class="required">*</span>'
                    : ''}
                                    </label>

                                    <input
                                        id="custpage_cuenta_bancaria"
                                        name="custpage_cuenta_bancaria"
                                        type="text"
                                        value="${escapeHtml(bankAccountValue)}"
                                        ${!data.vendorId ? 'required' : 'disabled'}
                                        placeholder="Captura la cuenta bancaria"
                                    >
                                </div>

                                <div class="field">
                                    <label for="custpage_banco">
                                        Banco
                                        ${!data.vendorId
                    ? ' <span class="required">*</span>'
                    : ''}
                                    </label>

                                    <select
                                        id="custpage_banco"
                                        name="custpage_banco"
                                        ${!data.vendorId ? 'required' : 'disabled'}
                                    >
                                        ${renderOptions(
                        bankOptions,
                        bankValue,
                        'Selecciona un banco'
                    )}
                                    </select>
                                </div>

                                ${countryConfig.plateRecord ? `
                                    <div class="field full">
                                        <label for="custpage_placas">
                                            Placas automóvil
                                        </label>

                                        <select
                                            id="custpage_placas"
                                            name="custpage_placas"
                                        >
                                            ${renderOptions(
                        plateOptions,
                        '',
                        'Sin placa / No aplica'
                    )}
                                        </select>
                                    </div>
                                ` : ''}

                      



                            </div>
                        </div>
                    </section>

                </div>

            </form>

            <script>
                (function () {
                    var processing = false;
                    var button = document.getElementById('createButton');

                    var manualTaxOptions =
                        ${JSON.stringify(taxOptions)};

                    var originalXmlTaxes =
                        ${JSON.stringify(invoice.taxes)};

                    var expenseCategoryOptions =
                        ${JSON.stringify(categoryOptions)};

                    var plannerItemOptions =
                        ${JSON.stringify(itemOptions)};

                    var invoiceSubtotal =
                        ${JSON.stringify(Number(toNumber(invoice.subtotal).toFixed(2)))};

                    var invoiceCurrency =
                        ${JSON.stringify(invoice.currencyCode || '')};

                    var isPeruInvoice =
                        ${JSON.stringify(invoice.countryCode === 'PE')};

                    var lineModeSelect =
                        document.getElementById('custpage_tipo_linea');


                    /*
                     * ITEMS: líneas de artículo.
                     * EXPENSES: líneas de gasto por categoría.
                     * Ambos modos llevan los mismos impuestos por línea.
                     */
                    function isItemMode() {
                        return lineModeSelect.value === 'ITEMS';
                    }


                    function showIgvColumn() {
                        return isPeruInvoice && isItemMode();
                    }

                    var distributionLines = [];
                    var distributionSequence = 0;


                    function escapeClientHtml(value) {
                        return String(value == null ? '' : value)
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;')
                            .replace(/'/g, '&#039;');
                    }


                    function formatMoney(value) {
                        return (Number(value || 0) || 0)
                            .toLocaleString(
                                'es-MX',
                                {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2
                                }
                            );
                    }


                    function normalizeClientTaxType(value) {

                        var normalized =
                            String(value || '')
                                .toUpperCase()
                                .normalize('NFD')
                                .replace(/[\u0300-\u036f]/g, '');


                        if (
                            ['TRANSFER','TRASLADO','IMPUESTO','TAX']
                                .indexOf(normalized) >= 0
                        ) {
                            return 'TRANSFER';
                        }


                        if (
                            [
                                'WITHHOLDING',
                                'RETENCION',
                                'RETENTION',
                                'RETEFUENTE',
                                'RETEIVA',
                                'RETEICA'
                            ].indexOf(normalized) >= 0
                        ) {
                            return 'WITHHOLDING';
                        }


                        if (
                            ['DETRACTION','DETRACCION','DETRACCIONES']
                                .indexOf(normalized) >= 0
                        ) {
                            return 'DETRACTION';
                        }


                        if (
                            ['EXEMPT','EXONERADO','EXONERADA']
                                .indexOf(normalized) >= 0
                        ) {
                            return 'EXEMPT';
                        }


                        if (
                            ['UNAFFECTED','INAFECTO','INAFECTA','NO GRAVADO']
                                .indexOf(normalized) >= 0
                        ) {
                            return 'UNAFFECTED';
                        }


                        return normalized;
                    }


                    function calculateTaxAmount(base, rate, type) {

                        if (
                            ['EXEMPT','UNAFFECTED'].indexOf(
                                normalizeClientTaxType(type)
                            ) >= 0
                        ) {
                            return 0;
                        }


                        return Number(
                            (
                                (Number(base || 0) || 0) *
                                ((Number(rate || 0) || 0) / 100)
                            ).toFixed(2)
                        );
                    }


                    /*
                     * Calcula la base de un impuesto XML para una categoría.
                     *
                     * Regla general:
                     * - Cada impuesto conserva la relación que su TaxableAmount
                     *   original tiene contra el subtotal del XML.
                     * - Si la categoría representa el 100% del subtotal, se
                     *   conserva exactamente la base original del impuesto.
                     * - Si el XML no informó TaxableAmount, se mantiene el
                     *   comportamiento anterior: la base es el importe de la
                     *   categoría.
                     *
                     * Ejemplo: subtotal 2,011,200; ReteIVA base 382,128.
                     * La relación es 19%, así que una categoría de 1,000,000
                     * recibe base ReteIVA de 190,000.
                     */
                    function getXmlTaxableAmountForLine(
                        originalTax,
                        lineAmount
                    ) {

                        var categoryAmount =
                            Math.abs(
                                Number(lineAmount || 0) || 0
                            );


                        var subtotalXml =
                            Math.abs(
                                Number(invoiceSubtotal || 0) || 0
                            );


                        var originalTaxableAmount =
                            Math.abs(
                                Number(
                                    originalTax &&
                                    originalTax.taxableAmount !== undefined &&
                                    originalTax.taxableAmount !== null &&
                                    originalTax.taxableAmount !== ''
                                        ? originalTax.taxableAmount
                                        : 0
                                ) || 0
                            );


                        /*
                         * Sin una base fiscal informada por el XML no inventamos
                         * una proporción. Conservamos la lógica previa.
                         */
                        if (
                            originalTaxableAmount <= 0 ||
                            subtotalXml <= 0
                        ) {
                            return Number(
                                categoryAmount.toFixed(2)
                            );
                        }


                        /*
                         * Para la línea que contiene todo el subtotal devolvemos
                         * la base XML exacta, evitando diferencias por redondeo.
                         */
                        if (
                            Math.abs(
                                categoryAmount -
                                subtotalXml
                            ) <= 0.01
                        ) {
                            return Number(
                                originalTaxableAmount.toFixed(2)
                            );
                        }


                        var proportion =
                            originalTaxableAmount /
                            subtotalXml;


                        return Number(
                            (
                                categoryAmount *
                                proportion
                            ).toFixed(2)
                        );
                    }


                    function cloneXmlTaxesForLine(lineAmount) {

                        return (originalXmlTaxes || []).map(
                            function (tax, sourceTaxIndex) {

                                var options =
                                    Array.isArray(tax.taxOptions)
                                        ? tax.taxOptions
                                        : [];


                                var taxId =
                                    tax.taxId ||
                                    (
                                        options.length === 1
                                            ? options[0].taxId
                                            : ''
                                    );


                                var taxName =
                                    tax.taxName ||
                                    (
                                        options.length === 1
                                            ? options[0].taxName
                                            : ''
                                    );


                                var taxableAmount =
                                    getXmlTaxableAmountForLine(
                                        tax,
                                        lineAmount
                                    );


                                return {
                                    source: 'XML',
                                    sourceTaxIndex: sourceTaxIndex,
                                    type: tax.type,
                                    authorityCode: tax.authorityCode,
                                    name: tax.name,
                                    rate: Number(tax.rate || 0) || 0,
                                    taxId: taxId || '',
                                    taxName: taxName || '',
                                    taxOptions: options,
                                    taxableAmount: taxableAmount,
                                    amount: calculateTaxAmount(
                                        taxableAmount,
                                        tax.rate,
                                        tax.type
                                    ),
                                    manual: false
                                };
                            }
                        );
                    }


                    function recalculateXmlTaxes(line) {

                        (line.taxes || []).forEach(
                            function (tax) {

                                if (tax.source !== 'XML') {
                                    return;
                                }


                                var originalTax =
                                    originalXmlTaxes[
                                        Number(
                                            tax.sourceTaxIndex
                                        )
                                    ] || null;


                                tax.taxableAmount =
                                    getXmlTaxableAmountForLine(
                                        originalTax || tax,
                                        line.amount
                                    );


                                tax.amount =
                                    calculateTaxAmount(
                                        tax.taxableAmount,
                                        tax.rate,
                                        tax.type
                                    );
                            }
                        );
                    }


                    function getLineTotal(line) {

                        var transfers =
                            (line.taxes || [])
                                .filter(function (tax) {
                                    return tax.type === 'TRANSFER';
                                })
                                .reduce(function (sum, tax) {
                                    return sum + Number(tax.amount || 0);
                                }, 0);


                        var withholdings =
                            (line.taxes || [])
                                .filter(function (tax) {
                                    return (
                                        ['WITHHOLDING','DETRACTION']
                                            .indexOf(tax.type) >= 0
                                    );
                                })
                                .reduce(function (sum, tax) {
                                    return sum + Number(tax.amount || 0);
                                }, 0);


                        return (
                            Number(line.amount || 0) +
                            transfers -
                            withholdings
                        );
                    }


                    function categoryOptionsHtml(selectedValue) {

                        return [
                            '<option value="">Selecciona una categoría</option>'
                        ].concat(
                            (expenseCategoryOptions || []).map(
                                function (option) {

                                    return (
                                        '<option value="' +
                                        escapeClientHtml(option.value) +
                                        '"' +
                                        (
                                            String(option.value) ===
                                            String(selectedValue || '')
                                                ? ' selected'
                                                : ''
                                        ) +
                                        '>' +
                                        escapeClientHtml(option.text) +
                                        '</option>'
                                    );
                                }
                            )
                        ).join('');
                    }


                    function itemOptionsHtml(selectedValue) {

                        return [
                            '<option value="">Selecciona un artículo</option>'
                        ].concat(
                            (plannerItemOptions || []).map(
                                function (option) {

                                    return (
                                        '<option value="' +
                                        escapeClientHtml(option.value) +
                                        '"' +
                                        (
                                            String(option.value) ===
                                            String(selectedValue || '')
                                                ? ' selected'
                                                : ''
                                        ) +
                                        '>' +
                                        escapeClientHtml(option.text) +
                                        '</option>'
                                    );
                                }
                            )
                        ).join('');
                    }


                    function taxesHtml(line) {

                        if (!line.taxes || !line.taxes.length) {

                            return (
                                '<span style="color:#8998aa;font-size:10.5px;">' +
                                'Sin impuestos asociados' +
                                '</span>'
                            );
                        }


                        return line.taxes.map(
                            function (tax) {

                                var requiresMapping =
                                    Array.isArray(tax.taxOptions) &&
                                    tax.taxOptions.length > 1 &&
                                    !tax.taxId;


                                var missing =
                                    (
                                        !tax.taxId &&
                                        ['EXEMPT','UNAFFECTED']
                                            .indexOf(tax.type) < 0
                                    );


                                return (
                                    '<span class="distribution-tax-pill ' +
                                    (
                                        tax.source === 'MANUAL'
                                            ? 'manual '
                                            : ''
                                    ) +
                                    (
                                        missing
                                            ? 'missing'
                                            : ''
                                    ) +
                                    '">' +
                                        escapeClientHtml(tax.source) +
                                        ' · ' +
                                        escapeClientHtml(
                                            requiresMapping
                                                ? 'Seleccionar código'
                                                : (
                                                    tax.taxName ||
                                                    tax.authorityCode ||
                                                    tax.taxId ||
                                                    'Sin código'
                                                )
                                        ) +
                                        ' · ' +
                                        escapeClientHtml(Number(tax.rate || 0)) +
                                        '% · ' +
                                        invoiceCurrency +
                                        ' ' +
                                        formatMoney(tax.amount) +
                                    '</span>'
                                );
                            }
                        ).join('');
                    }


                    function syncDistributionJson() {

                        var field =
                            document.getElementById(
                                'custpage_expense_distribution_json'
                            );


                        if (!field) {
                            return;
                        }


                        field.value =
                            JSON.stringify(
                                distributionLines.map(
                                    function (line) {

                                        return {
                                            itemId: line.itemId || '',
                                            categoryId: line.categoryId || '',
                                            appliesIgv: Boolean(line.appliesIgv),
                                            amount: Number(line.amount || 0) || 0,
                                            memo: line.memo || '',
                                            taxes: (line.taxes || []).map(
                                                function (tax) {

                                                    return {
                                                        source: tax.source,
                                                        sourceTaxIndex: tax.sourceTaxIndex,
                                                        taxId: tax.taxId || '',
                                                        taxName: tax.taxName || '',
                                                        type: tax.type,
                                                        rate: Number(tax.rate || 0) || 0,
                                                        taxableAmount:
                                                            Number(tax.taxableAmount || 0) || 0,
                                                        amount:
                                                            Number(tax.amount || 0) || 0,
                                                        manual: Boolean(tax.manual)
                                                    };
                                                }
                                            )
                                        };
                                    }
                                )
                            );
                    }


                    function updateDistributionSummary() {

                        var assigned =
                            distributionLines.reduce(
                                function (sum, line) {
                                    return sum + Number(line.amount || 0);
                                },
                                0
                            );


                        var pending =
                            Number(
                                (
                                    invoiceSubtotal -
                                    assigned
                                ).toFixed(2)
                            );


                        /*
                         * TOTAL PREVIO:
                         * suma en tiempo real exactamente los mismos
                         * totales que se muestran en la columna "Total línea".
                         */
                        var previewTotal =
                            distributionLines.reduce(
                                function (sum, line) {
                                    return (
                                        sum +
                                        Number(
                                            getLineTotal(line) || 0
                                        )
                                    );
                                },
                                0
                            );


                        var assignedNode =
                            document.getElementById(
                                'distributionAssigned'
                            );


                        var pendingNode =
                            document.getElementById(
                                'distributionPending'
                            );


                        var pendingBox =
                            document.getElementById(
                                'distributionPendingBox'
                            );


                        var previewTotalNode =
                            document.getElementById(
                                'distributionPreviewTotal'
                            );


                        if (assignedNode) {
                            assignedNode.textContent =
                                invoiceCurrency +
                                ' ' +
                                formatMoney(assigned);
                        }


                        if (pendingNode) {
                            pendingNode.textContent =
                                invoiceCurrency +
                                ' ' +
                                formatMoney(pending);
                        }


                        if (previewTotalNode) {
                            previewTotalNode.textContent =
                                invoiceCurrency +
                                ' ' +
                                formatMoney(previewTotal);
                        }


                        if (pendingBox) {

                            pendingBox.classList.toggle(
                                'complete',
                                Math.abs(pending) <= 0.01
                            );

                            pendingBox.classList.toggle(
                                'pending',
                                Math.abs(pending) > 0.01
                            );
                        }


                        syncDistributionJson();
                    }


                    function renderDistribution() {

                        var tbody =
                            document.getElementById(
                                'expenseDistributionBody'
                            );


                        if (!tbody) {
                            return;
                        }


                        tbody.innerHTML =
                            distributionLines.map(
                                function (line) {

                                    return (
                                        '<tr data-line-id="' +
                                        escapeClientHtml(line.id) +
                                        '">' +

                                            '<td>' +
                                                '<select class="distribution-select">' +
                                                    (
                                                        isItemMode()
                                                            ? itemOptionsHtml(line.itemId)
                                                            : categoryOptionsHtml(line.categoryId)
                                                    ) +
                                                '</select>' +
                                            '</td>' +

                                            (
                                                showIgvColumn()
                                                    ? '<td style="text-align:center;">' +
                                                        '<input ' +
                                                            'class="distribution-igv" ' +
                                                            'type="checkbox" ' +
                                                            'title="Aplica IGV"' +
                                                            (
                                                                line.appliesIgv
                                                                    ? ' checked'
                                                                    : ''
                                                            ) +
                                                        '>' +
                                                    '</td>'
                                                    : ''
                                            ) +

                                            '<td>' +
                                                '<input ' +
                                                    'class="distribution-amount" ' +
                                                    'type="number" ' +
                                                    'min="0.01" ' +
                                                    'step="0.01" ' +
                                                    'value="' +
                                                    escapeClientHtml(
                                                        Number(
                                                            line.amount || 0
                                                        ).toFixed(2)
                                                    ) +
                                                '">' +
                                            '</td>' +

                                            '<td>' +
                                                '<div class="distribution-tax-list">' +
                                                    taxesHtml(line) +
                                                '</div>' +
                                            '</td>' +

                                            '<td class="distribution-total">' +
                                                invoiceCurrency +
                                                ' ' +
                                                formatMoney(
                                                    getLineTotal(line)
                                                ) +
                                            '</td>' +

                                            '<td>' +
                                                '<div class="distribution-actions">' +

                                                    '<button ' +
                                                        'type="button" ' +
                                                        'class="distribution-btn manage-line-taxes"' +
                                                    '>' +
                                                        'Gestionar impuestos' +
                                                    '</button>' +

                                                    '<button ' +
                                                        'type="button" ' +
                                                        'class="distribution-btn danger remove-line"' +
                                                    '>' +
                                                        'Eliminar' +
                                                    '</button>' +

                                                '</div>' +
                                            '</td>' +

                                        '</tr>'
                                    );
                                }
                            ).join('');


                        Array.prototype.forEach.call(
                            tbody.querySelectorAll('tr[data-line-id]'),
                            function (row) {

                                var id =
                                    row.getAttribute(
                                        'data-line-id'
                                    );


                                var line =
                                    distributionLines.find(
                                        function (item) {
                                            return item.id === id;
                                        }
                                    );


                                if (!line) {
                                    return;
                                }


                                var targetSelect =
                                    row.querySelector(
                                        '.distribution-select'
                                    );


                                var igvCheck =
                                    row.querySelector(
                                        '.distribution-igv'
                                    );


                                var amount =
                                    row.querySelector(
                                        '.distribution-amount'
                                    );


                                var lineTotalNode =
                                    row.querySelector(
                                        '.distribution-total'
                                    );


                                var manage =
                                    row.querySelector(
                                        '.manage-line-taxes'
                                    );


                                var remove =
                                    row.querySelector(
                                        '.remove-line'
                                    );


                                /*
                                 * Artículo y categoría se guardan por separado:
                                 * al cambiar de modo no se pierde lo elegido.
                                 */
                                targetSelect.addEventListener(
                                    'change',
                                    function () {

                                        if (isItemMode()) {
                                            line.itemId = targetSelect.value;
                                        } else {
                                            line.categoryId = targetSelect.value;
                                        }

                                        syncDistributionJson();
                                    }
                                );


                                if (igvCheck) {

                                    igvCheck.addEventListener(
                                        'change',
                                        function () {

                                            line.appliesIgv =
                                                igvCheck.checked;

                                            syncDistributionJson();
                                        }
                                    );
                                }


                                /*
                                 * Mientras el usuario captura el importe,
                                 * actualizamos el Total línea y el Total previo
                                 * sin reconstruir la tabla, para no perder el foco.
                                 */
                                amount.addEventListener(
                                    'input',
                                    function () {

                                        line.amount =
                                            Number(
                                                amount.value || 0
                                            ) || 0;


                                        recalculateXmlTaxes(line);


                                        if (lineTotalNode) {
                                            lineTotalNode.textContent =
                                                invoiceCurrency +
                                                ' ' +
                                                formatMoney(
                                                    getLineTotal(line)
                                                );
                                        }


                                        updateDistributionSummary();
                                    }
                                );


                                /*
                                 * Al terminar la captura sí redibujamos para
                                 * refrescar también los importes mostrados
                                 * dentro de las etiquetas de impuestos.
                                 */
                                amount.addEventListener(
                                    'change',
                                    function () {

                                        line.amount =
                                            Number(
                                                amount.value || 0
                                            ) || 0;


                                        recalculateXmlTaxes(line);
                                        renderDistribution();
                                    }
                                );


                                manage.addEventListener(
                                    'click',
                                    function () {
                                        manageLineTaxes(line);
                                    }
                                );


                                remove.addEventListener(
                                    'click',
                                    async function () {

                                        if (
                                            distributionLines.length === 1
                                        ) {

                                            await Swal.fire({
                                                icon: 'warning',
                                                title: 'Se requiere una línea',
                                                text:
                                                    'La factura debe conservar al menos una línea.'
                                            });

                                            return;
                                        }


                                        var answer =
                                            await Swal.fire({
                                                icon: 'warning',
                                                title: '¿Eliminar esta línea?',
                                                text:
                                                    'También se eliminarán sus impuestos asociados.',
                                                showCancelButton: true,
                                                confirmButtonText: 'Sí, eliminar',
                                                cancelButtonText: 'Cancelar'
                                            });


                                        if (!answer.isConfirmed) {
                                            return;
                                        }


                                        distributionLines =
                                            distributionLines.filter(
                                                function (item) {
                                                    return item.id !== line.id;
                                                }
                                            );


                                        renderDistribution();
                                    }
                                );
                            }
                        );


                        updateDistributionSummary();
                    }


                    async function selectManualTaxCode() {

                        return new Promise(
                            function (resolve) {

                                Swal.fire({
                                    title: 'Selecciona código de impuesto',
                                    width: 720,

                                    html:
                                        '<div style="text-align:left;">' +
                                            '<input ' +
                                                'id="distributionTaxSearch" ' +
                                                'class="swal2-input" ' +
                                                'placeholder="Buscar por nombre, código o tasa..." ' +
                                                'style="width:100%;margin:0 0 10px;"' +
                                            '>' +
                                            '<div ' +
                                                'id="distributionTaxResults" ' +
                                                'style="' +
                                                    'max-height:280px;' +
                                                    'overflow:auto;' +
                                                    'border:1px solid #d8e1eb;' +
                                                    'border-radius:10px;' +
                                                    'padding:5px;' +
                                                '"' +
                                            '></div>' +
                                        '</div>',

                                    showConfirmButton: false,
                                    showCancelButton: true,
                                    cancelButtonText: 'Cancelar',

                                    didOpen: function () {

                                        var searchInput =
                                            document.getElementById(
                                                'distributionTaxSearch'
                                            );


                                        var results =
                                            document.getElementById(
                                                'distributionTaxResults'
                                            );


                                        function paint(value) {

                                            var filter =
                                                String(value || '')
                                                    .toLowerCase();


                                            var options =
                                                (manualTaxOptions || [])
                                                    .filter(
                                                        function (item) {

                                                            var searchable =
                                                                [
                                                                    item.value,
                                                                    item.text,
                                                                    item.xmlCode,
                                                                    item.behavior,
                                                                    item.rate
                                                                ]
                                                                    .join(' ')
                                                                    .toLowerCase();


                                                            return (
                                                                !filter ||
                                                                searchable.indexOf(filter) >= 0
                                                            );
                                                        }
                                                    );


                                            results.innerHTML =
                                                options.length
                                                    ? options.map(
                                                        function (item) {

                                                            return (
                                                                '<button ' +
                                                                    'type="button" ' +
                                                                    'data-manual-tax-id="' +
                                                                    escapeClientHtml(item.value) +
                                                                    '" ' +
                                                                    'style="' +
                                                                        'display:block;' +
                                                                        'width:100%;' +
                                                                        'padding:9px 10px;' +
                                                                        'border:0;' +
                                                                        'border-radius:7px;' +
                                                                        'background:transparent;' +
                                                                        'text-align:left;' +
                                                                        'cursor:pointer;' +
                                                                        'color:#203852;' +
                                                                        'font-size:11px;' +
                                                                    '"' +
                                                                '>' +
                                                                    '<b>' +
                                                                        escapeClientHtml(
                                                                            item.text ||
                                                                            item.value
                                                                        ) +
                                                                    '</b>' +
                                                                '</button>'
                                                            );
                                                        }
                                                    ).join('')
                                                    : (
                                                        '<div style="padding:14px;text-align:center;color:#8290a0;">' +
                                                            'Sin coincidencias' +
                                                        '</div>'
                                                    );


                                            Array.prototype.forEach.call(
                                                results.querySelectorAll(
                                                    '[data-manual-tax-id]'
                                                ),
                                                function (button) {

                                                    button.addEventListener(
                                                        'click',
                                                        function () {

                                                            var id =
                                                                button.getAttribute(
                                                                    'data-manual-tax-id'
                                                                );


                                                            Swal.close();

                                                            resolve(id);
                                                        }
                                                    );
                                                }
                                            );
                                        }


                                        searchInput.addEventListener(
                                            'input',
                                            function () {
                                                paint(searchInput.value);
                                            }
                                        );


                                        paint('');
                                        searchInput.focus();
                                    }

                                }).then(
                                    function (result) {

                                        if (
                                            result.dismiss &&
                                            result.dismiss !==
                                            'select'
                                        ) {
                                            resolve('');
                                        }
                                    }
                                );
                            }
                        );
                    }


                    async function addManualTaxToLine(line) {

                        if (
                            !manualTaxOptions ||
                            !manualTaxOptions.length
                        ) {

                            await Swal.fire({
                                icon: 'warning',
                                title: 'Sin impuestos configurados',
                                text:
                                    'No hay códigos de impuesto manuales disponibles para este país.'
                            });

                            return;
                        }


                        var taxId =
                            await selectManualTaxCode();


                        if (!taxId) {
                            return;
                        }


                        var selectedTax =
                            manualTaxOptions.find(
                                function (item) {
                                    return (
                                        String(item.value) ===
                                        String(taxId)
                                    );
                                }
                            );


                        if (!selectedTax) {
                            return;
                        }


                        var duplicateTax =
                            (line.taxes || []).find(
                                function (existingTax) {
                                    return (
                                        String(
                                            existingTax.taxId || ''
                                        ) ===
                                        String(
                                            selectedTax.value || ''
                                        )
                                    );
                                }
                            );


                        if (duplicateTax) {

                            await Swal.fire({
                                icon: 'warning',
                                title: 'Impuesto ya agregado',
                                html:
                                    'El Tax Code <b>' +
                                    escapeClientHtml(
                                        selectedTax.text ||
                                        selectedTax.value
                                    ) +
                                    '</b> ya existe en esta línea como impuesto <b>' +
                                    escapeClientHtml(
                                        String(
                                            duplicateTax.source ||
                                            'existente'
                                        )
                                    ) +
                                    '</b>.<br><br>' +
                                    'NetSuite sólo permite una vez el mismo Tax Code por línea.',
                                confirmButtonText: 'Entendido'
                            });

                            return;
                        }


                        var rate =
                            Number(
                                selectedTax.rate || 0
                            ) || 0;


                        if (rate <= 0) {

                            await Swal.fire({
                                icon: 'error',
                                title: 'Tasa no configurada',
                                text:
                                    'El código seleccionado no tiene una tasa válida configurada.'
                            });

                            return;
                        }


                        var taxType =
                            normalizeClientTaxType(
                                selectedTax.behavior
                            );


                        var baseResult =
                            await Swal.fire({
                                icon: 'info',
                                title: 'Base del impuesto',

                                html:
                                    '<div style="text-align:left;">' +

                                        '<div style="margin-bottom:10px;">' +
                                            'Código: <b>' +
                                            escapeClientHtml(
                                                selectedTax.text ||
                                                selectedTax.value
                                            ) +
                                            '</b>' +
                                        '</div>' +

                                        '<div style="margin-bottom:10px;">' +
                                            'Tasa: <b>' +
                                            rate +
                                            '%</b>' +
                                        '</div>' +

                                        '<div style="' +
                                            'padding:12px 14px;' +
                                            'border:1px solid #cfe0f7;' +
                                            'border-radius:10px;' +
                                            'background:#f4f8ff;' +
                                        '">' +

                                            '<div ' +
                                                'id="distributionManualFormula" ' +
                                                'style="font-size:12px;color:#52657a;"' +
                                            '>' +
                                                'Capture la base para calcular' +
                                            '</div>' +

                                            '<div ' +
                                                'id="distributionManualAmount" ' +
                                                'style="' +
                                                    'font-size:24px;' +
                                                    'font-weight:900;' +
                                                    'color:#0a4dcc;' +
                                                    'margin-top:5px;' +
                                                '"' +
                                            '>' +
                                                '0.00' +
                                            '</div>' +

                                            '<div style="font-size:10px;color:#66758a;">' +
                                                'Monto del impuesto' +
                                            '</div>' +

                                        '</div>' +

                                    '</div>',

                                input: 'number',
                                inputValue:
                                    Number(
                                        line.amount || 0
                                    ).toFixed(2),

                                inputAttributes: {
                                    min: '0.01',
                                    step: '0.01'
                                },

                                showCancelButton: true,
                                confirmButtonText: 'Agregar impuesto',
                                cancelButtonText: 'Cancelar',

                                didOpen: function () {

                                    var input =
                                        Swal.getInput();


                                    function refresh() {

                                        var base =
                                            Number(
                                                input
                                                    ? input.value
                                                    : 0
                                            ) || 0;


                                        var calculated =
                                            calculateTaxAmount(
                                                base,
                                                rate,
                                                taxType
                                            );


                                        var formula =
                                            document.getElementById(
                                                'distributionManualFormula'
                                            );


                                        var amount =
                                            document.getElementById(
                                                'distributionManualAmount'
                                            );


                                        if (formula) {
                                            formula.textContent =
                                                base > 0
                                                    ? (
                                                        formatMoney(base) +
                                                        ' × ' +
                                                        rate +
                                                        '%'
                                                    )
                                                    : 'Capture la base para calcular';
                                        }


                                        if (amount) {
                                            amount.textContent =
                                                formatMoney(calculated);
                                        }
                                    }


                                    input.addEventListener(
                                        'input',
                                        refresh
                                    );


                                    refresh();
                                },

                                inputValidator: function (value) {

                                    var base =
                                        Number(value || 0);


                                    return (
                                        !Number.isFinite(base) ||
                                        base <= 0
                                    )
                                        ? 'Capture una base mayor a cero.'
                                        : null;
                                }
                            });


                        if (!baseResult.isConfirmed) {
                            return;
                        }


                        var taxableAmount =
                            Number(
                                baseResult.value || 0
                            ) || 0;


                        line.taxes.push({
                            source: 'MANUAL',
                            sourceTaxIndex: null,
                            type: taxType,
                            authorityCode:
                                selectedTax.xmlCode ||
                                'MANUAL',
                            name:
                                selectedTax.text ||
                                'Impuesto manual',
                            rate: rate,
                            taxId: selectedTax.value,
                            taxName:
                                selectedTax.text ||
                                selectedTax.value,
                            taxableAmount: taxableAmount,
                            amount:
                                calculateTaxAmount(
                                    taxableAmount,
                                    rate,
                                    taxType
                                ),
                            manual: true
                        });


                        renderDistribution();
                    }


                    async function manageLineTaxes(line) {

                        var action =
                            '';


                        var rows =
                            (line.taxes || []).length
                                ? line.taxes.map(
                                    function (tax, index) {

                                        var options =
                                            Array.isArray(
                                                tax.taxOptions
                                            )
                                                ? tax.taxOptions
                                                : [];


                                        var codeControl =
                                            options.length > 1
                                                ? (
                                                    '<select ' +
                                                        'data-tax-mapping-index="' +
                                                        index +
                                                        '" ' +
                                                        'style="' +
                                                            'min-height:32px;' +
                                                            'font-size:10px;' +
                                                            'padding:0 7px;' +
                                                        '"' +
                                                    '>' +

                                                        '<option value="">' +
                                                            'Selecciona código' +
                                                        '</option>' +

                                                        options.map(
                                                            function (option) {

                                                                return (
                                                                    '<option value="' +
                                                                    escapeClientHtml(
                                                                        option.taxId
                                                                    ) +
                                                                    '"' +
                                                                    (
                                                                        String(option.taxId) ===
                                                                        String(tax.taxId || '')
                                                                            ? ' selected'
                                                                            : ''
                                                                    ) +
                                                                    '>' +
                                                                    escapeClientHtml(
                                                                        option.taxName ||
                                                                        option.taxId
                                                                    ) +
                                                                    '</option>'
                                                                );
                                                            }
                                                        ).join('') +

                                                    '</select>'
                                                )
                                                : escapeClientHtml(
                                                    tax.taxName ||
                                                    tax.taxId ||
                                                    '—'
                                                );


                                        return (
                                            '<tr>' +

                                                '<td style="padding:7px;border-bottom:1px solid #edf1f5;">' +
                                                    escapeClientHtml(tax.source) +
                                                '</td>' +

                                                '<td style="padding:7px;border-bottom:1px solid #edf1f5;">' +
                                                    escapeClientHtml(
                                                        tax.authorityCode ||
                                                        tax.name ||
                                                        '—'
                                                    ) +
                                                '</td>' +

                                                '<td style="padding:7px;border-bottom:1px solid #edf1f5;">' +
                                                    codeControl +
                                                '</td>' +

                                                '<td style="padding:7px;border-bottom:1px solid #edf1f5;text-align:right;">' +
                                                    Number(tax.rate || 0) +
                                                    '%' +
                                                '</td>' +

                                                '<td style="padding:7px;border-bottom:1px solid #edf1f5;text-align:right;">' +
                                                    formatMoney(
                                                        tax.taxableAmount
                                                    ) +
                                                '</td>' +

                                                '<td style="padding:7px;border-bottom:1px solid #edf1f5;text-align:right;"><b>' +
                                                    formatMoney(
                                                        tax.amount
                                                    ) +
                                                '</b></td>' +

                                                '<td style="padding:7px;border-bottom:1px solid #edf1f5;text-align:center;">' +
                                                    '<input ' +
                                                        'type="checkbox" ' +
                                                        'data-tax-remove-index="' +
                                                        index +
                                                        '"' +
                                                    '>' +
                                                '</td>' +

                                            '</tr>'
                                        );
                                    }
                                ).join('')
                                : (
                                    '<tr>' +
                                        '<td colspan="7" style="padding:18px;text-align:center;color:#8290a0;">' +
                                            'Esta línea no tiene impuestos asociados.' +
                                        '</td>' +
                                    '</tr>'
                                );


                        var result =
                            await Swal.fire({
                                title: 'Impuestos de la línea',
                                width: 920,

                                html:
                                    '<div style="text-align:left;margin-bottom:12px;">' +
                                        'Base de la línea: <b>' +
                                        invoiceCurrency +
                                        ' ' +
                                        formatMoney(line.amount) +
                                        '</b>' +
                                    '</div>' +

                                    '<div style="max-height:320px;overflow:auto;">' +

                                        '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
                                            '<thead>' +
                                                '<tr style="background:#f4f7fa;">' +
                                                    '<th style="padding:7px;text-align:left;">Origen</th>' +
                                                    '<th style="padding:7px;text-align:left;">Código XML</th>' +
                                                    '<th style="padding:7px;text-align:left;">Código NetSuite</th>' +
                                                    '<th style="padding:7px;text-align:right;">Tasa</th>' +
                                                    '<th style="padding:7px;text-align:right;">Base</th>' +
                                                    '<th style="padding:7px;text-align:right;">Impuesto</th>' +
                                                    '<th style="padding:7px;text-align:center;">Eliminar</th>' +
                                                '</tr>' +
                                            '</thead>' +

                                            '<tbody>' +
                                                rows +
                                            '</tbody>' +
                                        '</table>' +

                                    '</div>' +

                                    '<div style="display:flex;gap:8px;margin-top:15px;">' +

                                        '<button ' +
                                            'type="button" ' +
                                            'id="distributionAddManualInside" ' +
                                            'class="distribution-btn"' +
                                        '>' +
                                            '+ Agregar manual' +
                                        '</button>' +

                                        '<button ' +
                                            'type="button" ' +
                                            'id="distributionInheritXmlInside" ' +
                                            'class="distribution-btn"' +
                                        '>' +
                                            'Heredar XML' +
                                        '</button>' +

                                    '</div>',

                                showCancelButton: true,
                                confirmButtonText: 'Guardar cambios',
                                cancelButtonText: 'Cerrar',

                                preConfirm: function () {

                                    Array.prototype.forEach.call(
                                        document.querySelectorAll(
                                            '[data-tax-mapping-index]'
                                        ),
                                        function (select) {

                                            var index =
                                                Number(
                                                    select.getAttribute(
                                                        'data-tax-mapping-index'
                                                    )
                                                );


                                            var tax =
                                                line.taxes[index];


                                            var option =
                                                (tax.taxOptions || []).find(
                                                    function (item) {
                                                        return (
                                                            String(item.taxId) ===
                                                            String(select.value || '')
                                                        );
                                                    }
                                                );


                                            tax.taxId =
                                                option
                                                    ? option.taxId
                                                    : '';


                                            tax.taxName =
                                                option
                                                    ? (
                                                        option.taxName ||
                                                        ''
                                                    )
                                                    : '';
                                        }
                                    );


                                    var removeIndexes = [];


                                    Array.prototype.forEach.call(
                                        document.querySelectorAll(
                                            '[data-tax-remove-index]:checked'
                                        ),
                                        function (checkbox) {

                                            removeIndexes.push(
                                                Number(
                                                    checkbox.getAttribute(
                                                        'data-tax-remove-index'
                                                    )
                                                )
                                            );
                                        }
                                    );


                                    removeIndexes
                                        .sort(
                                            function (a, b) {
                                                return b - a;
                                            }
                                        )
                                        .forEach(
                                            function (index) {
                                                line.taxes.splice(
                                                    index,
                                                    1
                                                );
                                            }
                                        );


                                    return true;
                                },

                                didOpen: function () {

                                    document
                                        .getElementById(
                                            'distributionAddManualInside'
                                        )
                                        .addEventListener(
                                            'click',
                                            function () {

                                                action =
                                                    'MANUAL';

                                                Swal.close();
                                            }
                                        );


                                    document
                                        .getElementById(
                                            'distributionInheritXmlInside'
                                        )
                                        .addEventListener(
                                            'click',
                                            function () {

                                                action =
                                                    'XML';

                                                Swal.close();
                                            }
                                        );
                                }
                            });


                        if (action === 'MANUAL') {

                            await addManualTaxToLine(line);

                            return manageLineTaxes(line);
                        }


                        if (action === 'XML') {

                            line.taxes =
                                cloneXmlTaxesForLine(
                                    line.amount
                                );


                            renderDistribution();


                            await Swal.fire({
                                icon: 'success',
                                title: 'Impuestos XML heredados',
                                text:
                                    'Los impuestos del XML se recalcularon respetando proporcionalmente la base fiscal original de cada impuesto.',
                                timer: 1250,
                                showConfirmButton: false
                            });


                            return manageLineTaxes(line);
                        }


                        if (result.isConfirmed) {
                            renderDistribution();
                        }
                    }


                    function addDistributionLine(amount, inheritXml) {

                        distributionSequence += 1;


                        distributionLines.push({
                            id:
                                'expense_' +
                                distributionSequence,

                            itemId: '',
                            categoryId: '',
                            appliesIgv: false,
                            amount:
                                Number(amount || 0) || 0,
                            memo: '',
                            taxes:
                                inheritXml
                                    ? cloneXmlTaxesForLine(amount)
                                    : []
                        });


                        renderDistribution();
                    }


                    var addDistributionButton =
                        document.getElementById(
                            'addExpenseDistributionLine'
                        );


                    addDistributionButton.addEventListener(
                        'click',
                        function () {

                            var assigned =
                                distributionLines.reduce(
                                    function (sum, line) {
                                        return (
                                            sum +
                                            Number(line.amount || 0)
                                        );
                                    },
                                    0
                                );


                            var pending =
                                Math.max(
                                    0,
                                    Number(
                                        (
                                            invoiceSubtotal -
                                            assigned
                                        ).toFixed(2)
                                    )
                                );


                            addDistributionLine(
                                pending,
                                false
                            );
                        }
                    );


                    /*
                     * Textos y columnas que dependen del tipo de línea.
                     * Al cambiar de modo se redibuja la tabla con el catálogo
                     * correspondiente (artículos o categorías de gasto).
                     */
                    function applyLineModeLabels() {

                        var itemMode = isItemMode();

                        var labels = {
                            distributionSubtitle: itemMode
                                ? 'Cada fila genera una línea de artículo independiente. ' +
                                  'Los impuestos XML o manuales pertenecen únicamente al artículo de esa fila.'
                                : 'Cada fila genera una línea de gasto independiente. ' +
                                  'Los impuestos XML o manuales pertenecen únicamente a la categoría de esa fila.',
                            distributionModePill: itemMode ? 'Artículos' : 'Multi-categoría',
                            distributionTargetHeader: itemMode ? 'Artículo' : 'Categoría de gasto',
                            addExpenseDistributionLine: itemMode
                                ? '+ Agregar artículo'
                                : '+ Agregar categoría de gasto'
                        };

                        Object.keys(labels).forEach(function (id) {
                            var node = document.getElementById(id);

                            if (node) {
                                node.textContent = labels[id];
                            }
                        });


                        var igvHeader =
                            document.getElementById('distributionIgvHeader');

                        if (igvHeader) {
                            igvHeader.style.display =
                                showIgvColumn() ? '' : 'none';
                        }
                    }


                    lineModeSelect.addEventListener(
                        'change',
                        function () {
                            applyLineModeLabels();
                            renderDistribution();
                        }
                    );


                    applyLineModeLabels();


                    // Primera fila = subtotal completo + impuestos XML.
                    addDistributionLine(
                        invoiceSubtotal,
                        true
                    );


                    function validateExpenseDistribution() {

                        if (!distributionLines.length) {

                            return {
                                ok: false,
                                message:
                                    isItemMode()
                                        ? 'Debes agregar al menos un artículo.'
                                        : 'Debes agregar al menos una categoría de gasto.'
                            };
                        }


                        for (
                            var i = 0;
                            i < distributionLines.length;
                            i++
                        ) {

                            var line =
                                distributionLines[i];


                            if (isItemMode() ? !line.itemId : !line.categoryId) {

                                return {
                                    ok: false,
                                    message:
                                        (
                                            isItemMode()
                                                ? 'Selecciona el artículo de la línea '
                                                : 'Selecciona la categoría de gasto de la línea '
                                        ) +
                                        (i + 1) +
                                        '.'
                                };
                            }


                            if (
                                Number(line.amount || 0) <= 0
                            ) {

                                return {
                                    ok: false,
                                    message:
                                        'La base de la línea ' +
                                        (i + 1) +
                                        ' debe ser mayor a cero.'
                                };
                            }


                            for (
                                var j = 0;
                                j < (line.taxes || []).length;
                                j++
                            ) {

                                var tax =
                                    line.taxes[j];


                                if (
                                    tax.source === 'XML' &&
                                    !tax.taxId &&
                                    ['EXEMPT','UNAFFECTED']
                                        .indexOf(tax.type) < 0
                                ) {

                                    return {
                                        ok: false,
                                        message:
                                            'La línea ' +
                                            (i + 1) +
                                            ' tiene un impuesto XML sin código NetSuite. ' +
                                            'Usa “Gestionar impuestos”.'
                                    };
                                }
                            }
                        }


                        var assigned =
                            distributionLines.reduce(
                                function (sum, line) {
                                    return (
                                        sum +
                                        Number(line.amount || 0)
                                    );
                                },
                                0
                            );


                        var pending =
                            Number(
                                (
                                    invoiceSubtotal -
                                    assigned
                                ).toFixed(2)
                            );


                        if (
                            Math.abs(pending) > 0.01
                        ) {

                            return {
                                ok: false,
                                message:
                                    'El subtotal debe quedar completamente distribuido. ' +
                                    'Pendiente: ' +
                                    invoiceCurrency +
                                    ' ' +
                                    formatMoney(pending)
                            };
                        }


                        syncDistributionJson();


                        return {
                            ok: true
                        };
                    }


                    window.regresarCargaFactura = function () {
                        var currentUrl = new URL(window.location.href);
                        currentUrl.searchParams.delete('custpage_step');
                        currentUrl.searchParams.delete('custpage_ajax_request');
                        window.location.href = currentUrl.pathname + '?' + currentUrl.searchParams.toString();
                    };

                    function friendlyMessage(message) {
                        var text = String(message || 'No fue posible crear la factura.');

                        if (text.toLowerCase().includes('introduzca valores para: rfc')) {
                            return 'El proveedor no tiene RFC registrado. Captura el RFC del proveedor antes de crear la factura.';
                        }

                        if (text.toLowerCase().includes('introduzca valores para:')) {
                            return text.replace(
                                /^Introduzca valores para:\s*/i,
                                'Completa los siguientes datos obligatorios: '
                            );
                        }

                        return text;
                    }

                    window.crearFacturaAjax = async function () {
                        if (processing) return;

                        var form = document.getElementById('createInvoiceForm');

                        if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
                            Swal.fire({
                                icon: 'warning',
                                title: 'Revisa los campos obligatorios',
                                html: 'Completa la información marcada con <b>*</b> antes de crear la factura.',
                                confirmButtonText: 'Revisar formulario'
                            });
                            return;
                        }


                        var distributionValidation =
                            validateExpenseDistribution();


                        if (!distributionValidation.ok) {

                            Swal.fire({
                                icon: 'warning',
                                title: 'Revisa la distribución de gastos',
                                text: distributionValidation.message,
                                confirmButtonText: 'Revisar distribución'
                            });

                            return;
                        }


                        try {
                            processing = true;
                            button.disabled = true;

                            Swal.fire({
                                title: 'Creando factura en NetSuite',
                                html: '<div style="line-height:1.6">Estamos creando la transacción, aplicando impuestos y vinculando los documentos fiscales.</div>',
                                allowOutsideClick: false,
                                allowEscapeKey: false,
                                showConfirmButton: false,
                                didOpen: function () { Swal.showLoading(); }
                            });

                            syncDistributionJson();

                            var formData = new FormData(form);
                            formData.set('custpage_ajax_request', 'T');
                            formData.set('custpage_step', 'create');

                            var response = await fetch(window.location.href, {
                                method: 'POST',
                                body: formData,
                                credentials: 'same-origin'
                            });

                            var contentType = response.headers.get('content-type') || '';

                            if (!contentType.toLowerCase().includes('application/json')) {
                                throw new Error('NetSuite devolvió una respuesta inesperada al crear la factura.');
                            }

                            var result = await response.json();

                            if (!response.ok || result.success === false) {
                                throw new Error(result.message || 'No fue posible crear la factura.');
                            }

                            Swal.fire({
                                icon: 'success',
                                title: 'Factura creada correctamente',
                                html: '<div style="line-height:1.6">La transacción <b>' +
                                    String(result.transactionNumber || '') +
                                    '</b> quedó registrada en NetSuite.</div>',
                                showCancelButton: true,
                                confirmButtonText: 'Ver factura',
                                cancelButtonText: 'Volver al inicio',
                                allowOutsideClick: false,
                                allowEscapeKey: false
                            }).then(function (swalResult) {
                                if (swalResult.isConfirmed && result.redirectUrl) {
                                    window.open(result.redirectUrl, '_blank');
                                }

                                window.location.href = ${JSON.stringify(plannerHomeUrl)};
                            });

                        } catch (error) {
                            Swal.fire({
                                icon: 'error',
                                title: 'No fue posible crear la factura',
                                html: '<div style="line-height:1.55">' + friendlyMessage(error.message) + '</div>',
                                confirmButtonText: 'Entendido',
                                allowOutsideClick: false
                            });
                        } finally {
                            processing = false;
                            button.disabled = false;
                        }
                    };
                })();
            </script>

            ${getPageEnd()}
        `;

            writeHtml(context, html);
        } catch (functionError) {
            logFunctionError('renderValidationForm', functionError);
            throw functionError;
        }
    };

    const renderErrorPage = (context, error) => {
        try {
            const message = cleanText(error && error.message ? error.message : error) ||
                'No fue posible procesar la factura.';

            const html = `
            ${getPageStart({
                title: 'No fue posible procesar la factura',
                subtitle: 'Se encontró un problema durante el procesamiento del comprobante.',
                narrow: true
            })}

            <section class="card">
                <div class="card-body" style="padding:28px;">
                    <span class="status-pill" style="color:var(--danger);background:var(--danger-soft);border:1px solid #fecdca;">Error de procesamiento</span>
                    <h2 style="margin:18px 0 8px;font-size:18px;color:var(--navy);">Revisa la información e inténtalo nuevamente</h2>
                    <p style="margin:0;color:var(--muted);font-size:13px;line-height:1.6;">${escapeHtml(message)}</p>
                    <div class="actions" style="justify-content:flex-start;">
                        <button class="btn btn-secondary" type="button" onclick="history.back()">Regresar</button>
                    </div>
                </div>
            </section>

            <script>
                document.addEventListener('DOMContentLoaded', function () {
                    Swal.fire({
                        icon: 'error',
                        title: 'No fue posible procesar la factura',
                        text: ${JSON.stringify(message)},
                        confirmButtonText: 'Aceptar'
                    });
                });
            </script>

            ${getPageEnd()}
        `;

            writeHtml(context, html);
        } catch (functionError) {
            logFunctionError('renderErrorPage', functionError);
            throw functionError;
        }
    };


    // -------------------------------------------------------------------------
    // Endpoints y flujo principal
    // -------------------------------------------------------------------------

    const writeJson = (context, payload) => {
        try {
            context.response.setHeader({ name: 'Content-Type', value: 'application/json; charset=UTF-8' });
            context.response.write({ output: JSON.stringify(payload) });
        } catch (functionError) {
            logFunctionError('writeJson', functionError);
            throw functionError;
        }
    };

    const handleValidationUpload = context => {
        try {
            const request = context.request;
            const xmlUpload = request.files.custpage_xml;
            const pdfUpload = request.files.custpage_pdf;

            if (!xmlUpload || !pdfUpload) throw new Error('Debes cargar XML y PDF.');

            // Primero se valida. Sólo si es correcto se guardan los archivos.
            const invoice = parseElectronicInvoice(xmlUpload.getContents());

            const duplicate = findDuplicateBill(
                invoice.documentId,
                invoice.documentNumber
            );
            if (duplicate) {
                throw new Error(`El comprobante ya existe en la factura ${duplicate.transactionNumber}.`);
            }

            const subsidiary = findSubsidiary(invoice.customerTaxId);
            if (!subsidiary) {
                throw new Error(`No se encontró una subsidiaria con identificación fiscal ${invoice.customerTaxId}.`);
            }

            // La subsidiaria receptora tiene prioridad sobre la detección heurística UBL.
            if (['PE', 'CO'].includes(subsidiary.countryCode) && invoice.countryCode !== subsidiary.countryCode) {
                invoice.countryCode = subsidiary.countryCode;
                invoice.countryName = CONFIG.COUNTRY[subsidiary.countryCode].name;
            }

            const vendorId = findVendor(
                invoice.countryCode,
                invoice.supplierTaxId
            );
            const xmlId = saveUploadedFile(xmlUpload, file.Type.XMLDOC);
            const pdfId = saveUploadedFile(pdfUpload, file.Type.PDF);

            renderValidationForm(context, {
                invoice,
                subsidiary,
                vendorId,
                xmlFile: file.load({ id: xmlId }),
                pdfFile: file.load({ id: pdfId })
            });
        } catch (functionError) {
            logFunctionError('handleValidationUpload', functionError);
            throw functionError;
        }
    };

    const onRequest = context => {

        const request = context.request;
        const params = request.parameters || {};

        const isAjax =
            params.custpage_ajax_request === 'T';

        try {

            // =====================================================
            // GET
            // =====================================================

            if (request.method === 'GET') {

                if (params.action === 'validateDocument') {

                    const duplicate = findDuplicateBill(
                        cleanText(params.documentId).toUpperCase()
                    );

                    writeJson(context, {
                        success: true,
                        exists: Boolean(duplicate),
                        transactionNumber:
                            duplicate?.transactionNumber || null
                    });

                    return;
                }

                renderUploadForm(context, params);

                return;
            }

            // =====================================================
            // POST - CREAR VENDOR BILL
            // =====================================================

            if (
                request.method === 'POST' &&
                params.custpage_step === 'create'
            ) {

                const result = createVendorBill(params);

                if (isAjax) {

                    writeJson(context, {
                        success: true,
                        message:
                            `La factura ${result.transactionNumber} fue creada correctamente.`,
                        transactionNumber:
                            result.transactionNumber,
                        billId:
                            result.billId,
                        redirectUrl:
                            `/app/accounting/transactions/vendbill.nl?id=${result.billId}`
                    });

                    return;
                }

                context.response.sendRedirect({
                    type: 'SUITELET',
                    identifier:
                        runtime.getCurrentScript().id,
                    id:
                        runtime.getCurrentScript().deploymentId,
                    parameters: {
                        success: '1',
                        transactionNumber:
                            result.transactionNumber,
                        billId:
                            result.billId
                    }
                });

                return;
            }

            // =====================================================
            // POST - VALIDAR XML/PDF
            // =====================================================

            handleValidationUpload(context);

        } catch (error) {

            log.error({
                title: 'Error en carga de factura electrónica',
                details: error
            });

            /*
             * En una llamada fetch no dibujamos otra página.
             * Únicamente devolvemos el mensaje para SweetAlert.
             */
            if (isAjax) {

                writeJson(context, {
                    success: false,
                    message:
                        error.message ||
                        String(error) ||
                        'No fue posible procesar la factura.'
                });

                return;
            }

            // Respaldo para una llamada normal sin fetch.
            renderErrorPage(context, error);
        }
    };

    return { onRequest };
});