const Joi = require("joi")

const comLinkSchema = Joi.object({
    chain: Joi.object()
        .keys({
            current: Joi.object().keys({
                currentMessage: Joi.string().required(),
                currentMessageHash: Joi.string().required(),
                previousHashes: Joi.array().items(Joi.string()),
            }),
            comlinkCurrentHash: Joi.string(),
            comlinkCurrentHashSignature: Joi.any().required(),
        })
        .required(),
    muid: Joi.string().required(),
    properties: Joi.object()
        .keys({
            is_reply: Joi.boolean(),
            require_reply: Joi.boolean(),
        })
        .required(),
})

module.exports = comLinkSchema
