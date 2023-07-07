const Joi = require("joi")

const comLinkSchema = Joi.object({
    chain: Joi.object().required(),
    muid: Joi.string().required(),
    properties: Joi.object()
        .keys({
            is_reply: Joi.boolean(),
            require_reply: Joi.boolean(),
        })
        .required(),
})

module.exports = comLinkSchema
