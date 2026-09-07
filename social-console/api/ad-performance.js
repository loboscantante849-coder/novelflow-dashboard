'use strict';

const { handleAdPerformance } = require('./_lib/ad-performance');

module.exports = async (req, res) => handleAdPerformance(req, res);

module.exports.handleAdPerformance = handleAdPerformance;
